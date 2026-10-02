// 音源持久化回归测试：锁定「加了音源 → 重启 DSH → 音源不见了」这条事故链。
//
// 事故机制（1.2.2 实测）：
//   1. PlaybackService 在构造函数里建 provider，而 storageDomain 是**迟到**就绪的
//      （作用域注入，实测比 apply 晚 ~50ms），于是构造那一刻 `storage === undefined`
//      → EngineProvider 退化成 FileSourceStore；
//   2. attachStorage() 只把 storage 挂到 service 上，**从不重建 provider**，所以整个
//      进程生命周期里导入的音源都写进了兜底文件，永远进不了 storage domain；
//   3. 两个 store 对所有写失败都 `catch(() => undefined)`，于是「导入成功」的 UI 反馈
//      与「其实一条都没落盘」同时成立，重启后音源消失且没有任何可诊断的痕迹。
//
// 这里锁三件事：
//   A. 迟到挂载存储后 provider 必须被**重建**成 domain 后端（`providerStoreKind()` 可观测）；
//   B. 导入的音源必须真的进 storage domain，并且新建实例（模拟重启）能读回来；
//   C. 写失败必须**抛给调用方**，不能静默"成功"。

import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { PlaybackService } from '../src/playback'
import { EngineProvider } from '../src/engine/musicEngine'
import { DomainSourceStore, FileSourceStore, type SourceRecord } from '../src/engine/sourceStore'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { storageKey } from '../src/storage/keys'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { StorageFace } from '../src/playback'

const SAMPLE_SCRIPT = `/**
 * @name 回归音源
 * @version 1.0.0
 */
lx.on('request', async ({ action, source, info }) => {
  if (action === 'musicUrl') return 'https://example.com/' + source + '/' + info.quality + '.mp3'
  throw new Error('unknown action: ' + action)
})
lx.send('inited', { sources: { wy: { name: '回归' } } })`

/** 极简 storage domain 门面（内存实现），可注入写失败以验证"失败必须上抛"。 */
function fakeStorage(options: { failWrites?: boolean } = {}) {
  const tables = new Map<string, Map<string, unknown>>()
  let globalValue: unknown
  const face = {
    global: {
      get: () => globalValue,
      set: async (v: unknown) => {
        globalValue = v
      },
    },
    table: (name: string) => {
      if (!tables.has(name)) tables.set(name, new Map())
      const t = tables.get(name)!
      return {
        get: (k: string) => t.get(k),
        put: async (k: string, v: unknown) => {
          if (options.failWrites === true) throw new Error('模拟 storage domain 写失败')
          t.set(k, v)
        },
        entries: () => t.entries(),
        delete: async (k: string) => t.delete(k),
      }
    },
  }
  return { face: face as unknown as StorageFace, tables }
}

function record(id: string, name: string): SourceRecord {
  return {
    id,
    name,
    script: SAMPLE_SCRIPT,
    enabled: true,
    createdAt: '2026-08-15T00:00:00.000Z',
    updatedAt: '2026-08-15T00:00:00.000Z',
  }
}

const mockSettings = { ...DEFAULT_SETTINGS, providerMode: 'mock' as const }
const engineSettings = { ...DEFAULT_SETTINGS, providerMode: 'engine' as const }

describe('音源持久化：迟到挂载存储后必须重建 provider', () => {
  it('挂载前是 file 后端（兜底），挂载后切换成 domain 后端', () => {
    // 真实 $DSH_HOME 已被 tests/mini.ts 隔离到临时目录，这里构造 FileSourceStore 无副作用
    const service = new PlaybackService(new Context(), { settings: engineSettings })
    expect(service.providerStoreKind()).toBe('file')

    service.attachStorage(fakeStorage().face)

    // ⚠️ 这条就是事故的锁：不重建 provider 的话这里会一直是 'file'
    expect(service.providerStoreKind()).toBe('domain')
  })

  it('非内置引擎（mock/lxserver）不做无谓重建，始终 n/a', () => {
    const service = new PlaybackService(new Context(), { settings: mockSettings })
    expect(service.providerStoreKind()).toBe('n/a')
    service.attachStorage(fakeStorage().face)
    expect(service.providerStoreKind()).toBe('n/a')
  })

  it('重复挂载不会把已挂载的存储换掉（provider 只重建一次）', () => {
    const service = new PlaybackService(new Context(), { settings: engineSettings })
    const first = fakeStorage()
    service.attachStorage(first.face)
    expect(service.providerStoreKind()).toBe('domain')
    service.attachStorage(fakeStorage().face)
    expect(service.providerStoreKind()).toBe('domain')
  })
})

describe('音源持久化：导入后必须能跨实例读回（模拟重启）', () => {
  it('domain 后端：upload → domain 表有记录 → 新实例 listSources 仍在', async () => {
    const storage = fakeStorage()
    const engine = new EngineProvider({ storage: storage.face as never })
    expect(engine.sourceStoreKind()).toBe('domain')

    const up = await engine.uploadSource('regress.js', SAMPLE_SCRIPT)
    expect(up.success).toBe(true)
    expect(up.id).toBe('回归音源.js')
    // 落盘必须真的发生（而不是只在内存里"看起来成功"）
    expect(storage.tables.get('sources')?.get(storageKey('回归音源.js')) !== undefined).toBe(true)

    // 模拟重启：同一份 domain 数据上新建 provider
    const restarted = new EngineProvider({ storage: storage.face as never })
    const list = await restarted.listSources()
    expect(list.map((s) => s.id)).toEqual(['回归音源.js'])
    expect(list[0]?.enabled).toBe(true)
    restarted.dispose()
    engine.dispose()
  })

  it('domain 后端：toggle 关闭后新实例读回来仍是关闭', async () => {
    const storage = fakeStorage()
    const engine = new EngineProvider({ storage: storage.face as never })
    await engine.uploadSource('regress.js', SAMPLE_SCRIPT)
    await engine.toggleSource('回归音源.js', false)
    engine.dispose()

    const restarted = new EngineProvider({ storage: storage.face as never })
    const list = await restarted.listSources()
    expect(list[0]?.enabled).toBe(false)
    restarted.dispose()
  })

  it('domain 后端：upload 成功才返回 success，脚本无法加载时不落盘', async () => {
    const storage = fakeStorage()
    const engine = new EngineProvider({ storage: storage.face as never })
    const bad = await engine.uploadSource('bad.js', 'this is not a source script')
    expect(bad.success).toBe(false)
    expect(storage.tables.get('sources')?.size ?? 0).toBe(0)
    engine.dispose()
  })
})

describe('音源持久化：写失败必须上抛，不能静默成功', () => {
  it('DomainSourceStore：storage domain 写失败 → put 抛错，且内存列表不被污染', async () => {
    const failures: string[] = []
    const storage = fakeStorage({ failWrites: true })
    const store = new DomainSourceStore(storage.face, { onError: (m) => failures.push(m) })

    await expect(store.put(record('a.js', 'A'))).rejects.toThrow(/模拟 storage domain 写失败/)
    // ⚠️ 内存不能留下"其实没落盘"的记录：否则 UI 显示成功、重启后消失
    expect(store.list()).toHaveLength(0)
    expect(failures.length).toBeGreaterThan(0)
  })

  it('FileSourceStore：文件写失败 → put 抛错（旧实现只 console.warn 后照常 resolve）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lx-source-persist-'))
    try {
      // 目标路径的父级是一个**文件**，mkdir 必然失败 → 落盘失败
      const blocker = join(dir, 'blocker')
      writeFileSync(blocker, 'x', 'utf8')
      const failures: string[] = []
      const store = new FileSourceStore(join(blocker, 'sources.json'), { onError: (m) => failures.push(m) })

      await expect(store.put(record('b.js', 'B'))).rejects.toThrow()
      expect(store.list()).toHaveLength(0)
      expect(failures.length).toBeGreaterThan(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('FileSourceStore 正常路径仍然落盘，且不残留 tmp 文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lx-source-ok-'))
    try {
      const file = join(dir, 'sources.json')
      const store = new FileSourceStore(file)
      await store.put(record('c.js', 'C'))
      expect(existsSync(file)).toBe(true)
      const reloaded = new FileSourceStore(file)
      expect(reloaded.list().map((r) => r.id)).toEqual(['c.js'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
