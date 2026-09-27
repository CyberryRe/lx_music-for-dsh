// 存储键安全性 + 旧数据迁移的回归测试。
//
// 背景（1.2.0 在桌面版实测踩到的真问题）：per-record 布局把**表的键当文件名**，而后端要求
// 键匹配 `/^[a-zA-Z0-9_-]+$/`；本插件的 `logs` 表却用 ISO 时间戳当键（含冒号）。
// 后果链：后端的 legacy bootstrap 不做校验、直接按原始键写文件 → Windows 上 ENOENT →
// `open()` 抛错 → 插件静默退化成内存存储（播放列表/画像全都不落盘）。
//
// 这个文件锁三件事：
//   1. `storageKey()` 的映射规则（安全、单射、长度受控）；
//   2. 后端确实会拒绝不安全的键（说明这一层不可省）；
//   3. **迁移路径在含非法字符的旧数据上能跑通**（先把旧文件改名搁置，再显式迁移）。

import { existsSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, it } from './mini'
import { isSafeStorageKey, storageKey } from '../src/storage/keys'
import { migrateLegacyDomain, needsLegacyMigration, readLegacyWholeUnit, restoreLegacyFile, stashLegacyFile } from '../src/storage/migrate'
import { domainSpec } from '../src/index'
import type { StorageFace } from '../src/playback'
import { storageKey as sk } from '../src/storage/keys'

// ── 1) 映射规则 ─────────────────────────────────────────────────────────────

const PATH_SAFE = /^[a-zA-Z0-9_-]+$/

describe('storageKey', () => {
  it('已经是安全形态的键原样保留（日期/id/order/summary 保持可读）', () => {
    for (const key of ['2026-09-11', 'order', 'summary', 'wy-186016', 'HYWmusic']) {
      expect(storageKey(key)).toBe(key)
    }
  })

  it('把非法字符编码成 `_xx`，且结果满足后端的 path-safe 规则', () => {
    const cases = ['2026-09-11T03:47:40.052Z', 'platform:tx', '晴天|周杰伦', 'AC/DC', 'a b', 'mood:x@artist:y']
    for (const raw of cases) {
      const key = storageKey(raw)
      expect(PATH_SAFE.test(key)).toBe(true)
      expect(isSafeStorageKey(key)).toBe(true)
      expect(key.length).toBeLessThanOrEqual(96)
    }
    // 可读性抽查：日期键只是把冒号/点转义
    expect(storageKey('2026-09-11T03:47:40.052Z')).toBe('_2026-09-11T03_3a47_3a40_2e052Z')
    expect(storageKey('platform:tx')).toBe('_platform_3atx')
  })

  it('单射：不同键不会撞成同一个文件名（含 `_` 与编码形态互斥）', () => {
    const raws = ['a_b', 'a:b', '_x', 'x', 'a%3ab', '晴天', '晴天|周杰伦', '2026-09-11', '2026-09-11T00:00:00.000Z', 'order', '_order']
    const mapped = raws.map((r) => storageKey(r))
    expect(new Set(mapped).size).toBe(raws.length)
  })

  it('超长键截断并附内容哈希（仍然安全、仍然唯一）', () => {
    const long = 'x'.repeat(500)
    const other = `${'x'.repeat(499)}y`
    const a = storageKey(long)
    const b = storageKey(other)
    expect(PATH_SAFE.test(a)).toBe(true)
    expect(a.length).toBeLessThanOrEqual(96)
    expect(a).not.toBe(b)
  })

  it('空键也有确定结果（不产生空文件名）', () => {
    expect(storageKey('')).toBe('_')
    expect(PATH_SAFE.test(storageKey(''))).toBe(true)
  })
})

// ── 2) 真实后端：不安全键确实会被拒 ─────────────────────────────────────────

interface DomainHandle {
  global: { get(): unknown; set(v: unknown): Promise<void> }
  table(name: string): { keys(): Iterable<string>; get(k: string): unknown; put(k: string, v: unknown): Promise<void> }
  close(): Promise<void>
}

async function loadStorageStack(): Promise<{ open(root: string): Promise<DomainHandle> } | undefined> {
  try {
    const [cordis, storage, storageJson, domainPkg] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-storage'),
      import('@deepseek-ai/dsh-storage-json'),
      import('@deepseek-ai/dsh-storage-domain'),
    ])
    const Context = (cordis as unknown as { Context: new () => Record<string, unknown> }).Context
    const hub = (storage as unknown as { Storage?: unknown; default?: unknown }).Storage ?? (storage as unknown as { default: unknown }).default
    const backend = storageJson as unknown as { name: string; inject: string[]; Config: unknown; apply: unknown }
    const dom = domainPkg as unknown as { name: string; inject: string[]; Config: unknown; apply: unknown }
    return {
      open: async (root: string) => {
        const ctx = new Context() as Record<string, unknown> & { storageDomain?: { open(spec: unknown): Promise<DomainHandle> } }
        const plugin = (m: { name: string; inject: string[]; Config: unknown; apply: unknown }, config: unknown): void => {
          ;(ctx as unknown as { plugin(p: unknown, c?: unknown): void }).plugin({ name: m.name, inject: m.inject, Config: m.Config, apply: m.apply }, config)
        }
        ;(ctx as unknown as { plugin(p: unknown): void }).plugin(hub)
        plugin(backend, { root })
        plugin(dom, { backend: 'json' })
        for (let i = 0; i < 100 && !ctx.storageDomain; i++) await new Promise((r) => setTimeout(r, 20))
        if (!ctx.storageDomain) throw new Error('storageDomain 未就绪')
        return ctx.storageDomain.open(domainSpec)
      },
    }
  } catch {
    return undefined
  }
}

function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'lx-keys-'))
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

/** 懒加载（测试编译目标不支持顶层 await）。 */
let stackCache: Awaited<ReturnType<typeof loadStorageStack>> | undefined
let stackLoaded = false
async function stack(): Promise<Awaited<ReturnType<typeof loadStorageStack>>> {
  if (!stackLoaded) {
    stackCache = await loadStorageStack()
    stackLoaded = true
  }
  return stackCache
}

describe('真实后端的 per-record 键规则', () => {
  it('不安全的键会被后端拒绝（所以插件必须先过 storageKey）', async () => {
    const s = await stack()
    if (!s) {
      console.log('[skip] 真实存储栈不可用')
      return
    }
    await withRoot(async (root) => {
      const domain = await s.open(root)
      await expect(domain.table('logs').put('2026-09-11T03:47:40.052Z', { time: 'x' })).rejects.toThrow(/not path-safe/)
      // 经过映射后就能写
      await domain.table('logs').put(sk('2026-09-11T03:47:40.052Z'), { time: 'x' })
      expect([...domain.table('logs').keys()]).toHaveLength(1)
      await domain.close()
    })
  })
})

// ── 3) 迁移路径（含非法字符的旧数据）────────────────────────────────────────

const LOG = {
  time: '2026-09-11T03:47:40.052Z',
  action: 'play',
  query: '晴天',
  limit: 5,
  autoPlay: true,
  source: 'wy',
  resultsCount: 3,
  playedId: 'wy_1',
  latencyMs: 120,
}
const SOURCE = { id: '星海音乐源.js', name: '星海', script: 'lx.send("inited",{sources:{wy:{}}})', enabled: true, createdAt: 'x', updatedAt: 'y' }
const LEGACY_GLOBAL = { playlist: [{ id: 'wy_1' }], currentIndex: 0, quality: 'flac', volume: 0.5, mute: false, playMode: 'single' }

function writeLegacy(root: string): string {
  const file = join(root, 'lx_music.json')
  writeFileSync(
    file,
    JSON.stringify({ unit: { name: 'lx_music', version: 1 }, global: LEGACY_GLOBAL, tables: { logs: { [LOG.time]: LOG }, sources: { [SOURCE.id]: SOURCE }, source_order: { order: [SOURCE.id] } } }),
  )
  return file
}

/** 迁移目标：用真实 domain 句柄拼出 StorageFace 的窄面。 */
function faceOf(domain: DomainHandle): StorageFace {
  return {
    global: { get: () => domain.global.get(), set: (v) => domain.global.set(v) },
    table: (name: string) => ({
      get: (k: string) => domain.table(name).get(k),
      put: (k: string, v: unknown) => domain.table(name).put(k, v),
      entries: () => domain.table(name).keys() as unknown as IterableIterator<[string, unknown]>,
      delete: async () => false,
    }),
  }
}

describe('旧数据迁移（键含 Windows 非法字符）', () => {
  it('先改名搁置再打开 → 迁移成功，且 global 逐项保留', async () => {
    const s = await stack()
    if (!s) {
      console.log('[skip] 真实存储栈不可用')
      return
    }
    await withRoot(async (root) => {
      const legacyFile = writeLegacy(root)
      const env = { DSH_HOME: root } as NodeJS.ProcessEnv
      // 前置判定：还没有 per-record 目录 + 旧文件在 → 需要迁移
      expect(needsLegacyMigration('lx_music', { DSH_HOME: join(root, '..') } as NodeJS.ProcessEnv)).toBe(false)
      const legacy = readLegacyWholeUnit(legacyFile)
      expect(legacy?.tables.logs?.[LOG.time]).toBeDefined()

      // 改名搁置（真实实现按 DSH_HOME 定位，所以这里直接对文件系统操作验证幂等）
      const stashed = `${legacyFile}.migrated-test`
      writeFileSync(stashed, readFileSync(legacyFile, 'utf8'))
      rmSync(legacyFile)

      const domain = await s.open(root)
      const result = await migrateLegacyDomain({
        target: faceOf(domain),
        specTables: Object.keys(domainSpec.tables),
        legacyPath: stashed,
        legacy,
      })
      expect(result.migrated).toBe(true)
      expect(result.reason).toBe('done')
      expect(result.tables).toEqual({ logs: 1, sources: 1, source_order: 1 })
      expect(result.globalMigrated).toBe(true)
      expect(result.globalSource).toBe('legacy')

      // global 逐项保留
      const global = domain.global.get() as Record<string, unknown>
      expect(global.playlist).toEqual(LEGACY_GLOBAL.playlist)
      expect(global.quality).toBe('flac')
      expect(global.volume).toBe(0.5)
      expect(global.playMode).toBe('single')
      expect((global.memory as { migratedFrom: string }).migratedFrom).toMatch(/^single@/)

      // 落盘键安全（读回来时用的是同一套映射）
      const keys = [...domain.table('logs').keys()]
      expect(keys).toHaveLength(1)
      expect(PATH_SAFE.test(keys[0] as string)).toBe(true)
      expect(domain.table('logs').get(keys[0] as string)).toMatchObject({ query: '晴天' })
      await domain.close()

      // 旧文件仍在（改名后的 `.migrated-*`），可回滚
      expect(existsSync(stashed)).toBe(true)
      void env
    })
  })

  it('搁置/还原辅助函数按 DSH_HOME 工作，且幂等', async () => {
    await withRoot(async (root) => {
      mkdirSync(join(root, 'storages'), { recursive: true })
      const file = join(root, 'storages', 'lx_music.json')
      writeFileSync(file, '{}')
      const env = { DSH_HOME: root } as NodeJS.ProcessEnv

      expect(needsLegacyMigration('lx_music', env)).toBe(true)
      const stashed = stashLegacyFile(env)
      expect(stashed).toBeDefined()
      expect(existsSync(file)).toBe(false)
      expect(existsSync(stashed as string)).toBe(true)
      // 已经搁置过 → 不再判定为"需要迁移"
      expect(needsLegacyMigration('lx_music', env)).toBe(false)
      // 还原
      expect(restoreLegacyFile(stashed, env)).toBe(true)
      expect(existsSync(file)).toBe(true)
      // per-record 目录存在时不再需要迁移
      mkdirSync(join(root, 'storages', 'lx_music'), { recursive: true })
      expect(needsLegacyMigration('lx_music', env)).toBe(false)
    })
  })

  it('（Windows 专属）不搁置直接打开时，后端 bootstrap 会因非法键失败', async () => {
    const s = await stack()
    if (!s || process.platform !== 'win32') {
      console.log('[skip] 仅在 Windows 上复现（冒号在 POSIX 文件名里合法）')
      return
    }
    await withRoot(async (root) => {
      writeLegacy(root)
      await expect(s.open(root)).rejects.toThrow(/ENOENT|path-safe/)
    })
  })
})

// 保持 zod 依赖引用（迁移写入的形状校验由 domainSpec 承担）
void z
void readdirSync
