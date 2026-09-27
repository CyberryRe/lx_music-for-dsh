// 旧版 single 布局 → per-record 的一次性迁移。
// 重点：global 必须显式迁移（backend 的 legacy bootstrap 不带 global，而播放列表/设置全在 global）、
//      幂等、失败可重试（标记只在最后写）、绝不修改旧文件。
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from './mini'
import { defaultDomainFile, migrateLegacyDomain, readLegacyWholeUnit } from '../src/storage/migrate'
import type { StorageFace } from '../src/playback'

/** 与 tests/host.integration.test.ts 一致的 fake storage domain。 */
function fakeStorage(initialGlobal?: unknown): StorageFace & { tables: Map<string, Map<string, unknown>>; globalWrites: unknown[] } {
  const globalStore = new Map<string, unknown>()
  if (initialGlobal !== undefined) globalStore.set('state', initialGlobal)
  const tables = new Map<string, Map<string, unknown>>()
  const globalWrites: unknown[] = []
  return {
    tables,
    globalWrites,
    global: {
      get: () => globalStore.get('state'),
      set: async (v: unknown) => {
        globalWrites.push(v)
        globalStore.set('state', v)
      },
    },
    table: (name: string) => {
      if (!tables.has(name)) tables.set(name, new Map())
      const t = tables.get(name)!
      return {
        get: (k: string) => t.get(k),
        put: async (k: string, v: unknown) => {
          t.set(k, v)
        },
        entries: () => t.entries(),
        delete: async (k: string) => t.delete(k),
      }
    },
  }
}

const LEGACY_GLOBAL = {
  playlist: [{ id: 'wy_1', source: 'wy', name: '晴天', singer: '周杰伦' }],
  currentIndex: 0,
  quality: 'flac',
  volume: 0.42,
  mute: true,
  playMode: 'shuffle',
  settings: { platformPriority: ['tx'] },
}

function legacyDoc(global: unknown = LEGACY_GLOBAL): string {
  return JSON.stringify({
    unit: { name: 'lx_music', version: 1 },
    global,
    tables: {
      logs: { '2026-01-01T00:00:00.000Z': { time: '2026-01-01T00:00:00.000Z', query: '晴天', limit: 5, autoPlay: true, source: 'wy', resultsCount: 3, playedId: 'wy_1', latencyMs: 120 } },
      sources: { 'a.js': { id: 'a.js', name: 'A', script: 'lx.send("inited",{sources:{wy:{}}})', enabled: true, createdAt: 'x', updatedAt: 'y' } },
      source_order: { order: ['a.js'] },
      // 旧文件里多出来的表（新 spec 没有）必须被忽略
      removed_table: { k: { v: 1 } },
    },
  })
}

function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'lx-migrate-'))
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }))
}

const SPEC_TABLES = ['logs', 'sources', 'source_order']

describe('migrateLegacyDomain', () => {
  it('没有旧文件时不迁移（全新安装）', async () => {
    await withTempDir(async (dir) => {
      const target = fakeStorage()
      const res = await migrateLegacyDomain({ target, specTables: SPEC_TABLES, legacyPath: join(dir, 'nope.json') })
      expect(res.migrated).toBe(false)
      expect(res.reason).toBe('no-legacy-file')
      expect(target.globalWrites).toHaveLength(0)
    })
  })

  it('旧文件不是合法 JSON 时按"无需迁移"处理，不抛错', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'lx_music.json')
      writeFileSync(file, '{{{ not json')
      const target = fakeStorage()
      const res = await migrateLegacyDomain({ target, specTables: SPEC_TABLES, legacyPath: file })
      expect(res.reason).toBe('no-legacy-file')
    })
  })

  it('表记录 + global 全部迁移，并写入幂等标记', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'lx_music.json')
      writeFileSync(file, legacyDoc())
      const target = fakeStorage()
      const res = await migrateLegacyDomain({ target, specTables: SPEC_TABLES, legacyPath: file, now: () => Date.UTC(2026, 0, 2) })

      expect(res.migrated).toBe(true)
      expect(res.reason).toBe('done')
      expect(res.globalMigrated).toBe(true)
      expect(res.tables).toEqual({ logs: 1, sources: 1, source_order: 1 })

      // 表记录按原样写入；旧文件里多出来的表被忽略
      expect(target.tables.get('logs')?.size).toBe(1)
      expect(target.tables.get('source_order')?.get('order')).toEqual(['a.js'])
      expect(target.tables.has('removed_table')).toBe(false)

      // global：播放列表/当前索引/音质/音量/静音/播放模式/设置一个都不能丢
      const global = target.global.get() as Record<string, unknown>
      expect(global.playlist).toEqual(LEGACY_GLOBAL.playlist)
      expect(global.currentIndex).toBe(0)
      expect(global.quality).toBe('flac')
      expect(global.volume).toBe(0.42)
      expect(global.mute).toBe(true)
      expect(global.playMode).toBe('shuffle')
      expect(global.settings).toEqual({ platformPriority: ['tx'] })
      expect(res.globalSource).toBe('legacy')
      expect((global.memory as { migratedFrom: string }).migratedFrom).toBe('single@2026-01-02T00:00:00.000Z')
    })
  })

  it('幂等：第二次运行不再写入 global（标记已存在）', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'lx_music.json')
      writeFileSync(file, legacyDoc())
      const target = fakeStorage()
      await migrateLegacyDomain({ target, specTables: SPEC_TABLES, legacyPath: file })
      const afterFirst = target.globalWrites.length

      const second = await migrateLegacyDomain({ target, specTables: SPEC_TABLES, legacyPath: file })
      expect(second.migrated).toBe(false)
      expect(second.reason).toBe('already-migrated')
      expect(target.globalWrites).toHaveLength(afterFirst)
    })
  })

  it('绝不修改旧文件（内容逐字节不变）', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'lx_music.json')
      const body = legacyDoc()
      writeFileSync(file, body)
      const target = fakeStorage()
      await migrateLegacyDomain({ target, specTables: SPEC_TABLES, legacyPath: file })
      expect(readFileSync(file, 'utf8')).toBe(body)
    })
  })

  it('目标 global 已被真正使用过时，新值优先、旧值补缺（不做回退）', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'lx_music.json')
      writeFileSync(file, legacyDoc())
      // 新 domain 里已经有一份"升级后被写过"的状态
      const target = fakeStorage({ playlist: [{ id: 'tx_9' }], currentIndex: 0, volume: 0.9, quality: '320k', mute: false })
      const res = await migrateLegacyDomain({ target, specTables: SPEC_TABLES, legacyPath: file })

      expect(res.globalSource).toBe('merged')
      const global = target.global.get() as Record<string, unknown>
      expect(global.playlist).toEqual([{ id: 'tx_9' }]) // 新值优先
      expect(global.volume).toBe(0.9)
      expect(global.mute).toBe(false)
      // 旧值补齐新 global 缺失的键，且写入标记
      expect(global.playMode).toBe('shuffle')
      expect((global.memory as { migratedFrom: string }).migratedFrom).toMatch(/^single@/)
    })
  })

  it('旧文件 global 为 null 时，保留当前 global 并只补标记', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'lx_music.json')
      writeFileSync(file, legacyDoc(null))
      const target = fakeStorage({ playlist: [], currentIndex: -1, quality: '320k', volume: 1, mute: false })
      const res = await migrateLegacyDomain({ target, specTables: SPEC_TABLES, legacyPath: file })

      expect(res.migrated).toBe(true)
      expect(res.globalSource).toBe('none')
      const global = target.global.get() as Record<string, unknown>
      expect(global.volume).toBe(1)
      expect((global.memory as { migratedFrom: string }).migratedFrom).toMatch(/^single@/)
    })
  })

  it('global 写入失败时不写标记（下次启动重试），且表记录已写入', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'lx_music.json')
      writeFileSync(file, legacyDoc())
      const target = fakeStorage()
      target.global.set = async () => {
        throw new Error('disk full')
      }
      const warnings: string[] = []
      const res = await migrateLegacyDomain({
        target,
        specTables: SPEC_TABLES,
        legacyPath: file,
        warn: (m) => warnings.push(m),
      })
      expect(res.globalMigrated).toBe(false)
      expect(res.tables).toEqual({ logs: 1, sources: 1, source_order: 1 })
      expect(warnings.join('\n')).toContain('global 写入失败')

      // 重试：这次 global 能写成功 → 标记落下
      const ok = fakeStorage()
      const retry = await migrateLegacyDomain({ target: ok, specTables: SPEC_TABLES, legacyPath: file })
      expect(retry.globalMigrated).toBe(true)
    })
  })

  it('表记录写入失败时返回 failed、不写 global（保留重试机会）', async () => {
    await withTempDir(async (dir) => {
      const file = join(dir, 'lx_music.json')
      writeFileSync(file, legacyDoc())
      const target = fakeStorage()
      target.table = () => ({
        get: () => undefined,
        put: async () => {
          throw new Error('write failed')
        },
        entries: () => new Map<string, unknown>().entries(),
        delete: async () => false,
      })
      const warnings: string[] = []
      const res = await migrateLegacyDomain({ target, specTables: SPEC_TABLES, legacyPath: file, warn: (m) => warnings.push(m) })
      expect(res.migrated).toBe(false)
      expect(res.reason).toBe('failed')
      expect(target.globalWrites).toHaveLength(0)
      expect(warnings.join('\n')).toContain('表记录写入失败')
    })
  })
})

describe('readLegacyWholeUnit / defaultDomainFile', () => {
  it('解析出 unitVersion/global/tables，非对象表被忽略', async () => {
    await withTempDir((dir) => {
      const file = join(dir, 'lx_music.json')
      writeFileSync(file, JSON.stringify({ unit: { name: 'lx_music', version: 1 }, global: { a: 1 }, tables: { t: { k: 1 }, bad: [1, 2] } }))
      const parsed = readLegacyWholeUnit(file)
      expect(parsed?.unitVersion).toBe(1)
      expect(parsed?.global).toEqual({ a: 1 })
      expect(Object.keys(parsed?.tables ?? {})).toEqual(['t'])
    })
  })

  it('defaultDomainFile 跟随 DSH_HOME', () => {
    expect(defaultDomainFile({ DSH_HOME: 'D:\\x\\.dsh' } as NodeJS.ProcessEnv)).toBe(join('D:\\x\\.dsh', 'storages', 'lx_music.json'))
    // 未设置时回退 ~/.dsh
    expect(defaultDomainFile({} as NodeJS.ProcessEnv).endsWith(join('.dsh', 'storages', 'lx_music.json'))).toBe(true)
  })
})
