// 插件激活路径测试。
//
// 背景（1.2.0 桌面版实测的重大缺陷）：`inject` 里写了 `['tools', 'storageDomain']`，
// 而 `storageDomain` 其实是**可选**能力（代码里本来就写了"不可用就内存跑"的降级分支）。
// cordis 的 `inject` 是**必需依赖**：服务没就绪时**根本不会调用 apply** ——
// 于是 PlaybackService 不存在、工具一个都没注册，客户端表现为 `lxPlayback/*` 一律 404，
// 存储目录也永远不出现（连"内存模式能用"都做不到）。
//
// 这个文件锁三件事：
//   1. `inject` 只声明真正必需的依赖（可选能力必须走作用域注入）；
//   2. 没有存储时插件**照样激活**：服务 + 音乐工具都在（内存模式）；
//   3. 存储迟到就绪时能把持久层与画像补挂上（不必重启插件），并把过程写入状态文件。

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { Config, apply, inject } from '../src/index'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import { PLUGIN_VERSION, statusFilePath } from '../src/status'

interface ToolLike {
  name: string
}

function fakeStorageDomain() {
  const globalStore = new Map<string, unknown>()
  const tables = new Map<string, Map<string, unknown>>()
  const domain = {
    global: {
      get: () => globalStore.get('state'),
      set: async (v: unknown) => {
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
  return { open: async () => domain, tables }
}

/** 用临时 DSH_HOME 跑一段（状态文件写到那里，不污染真实 ~/.dsh）。 */
async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), 'lx-activation-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

function readStatus(home: string): { history: Array<Record<string, unknown>> } | undefined {
  const file = statusFilePath({ DSH_HOME: home } as NodeJS.ProcessEnv)
  if (!existsSync(file)) return undefined
  return JSON.parse(readFileSync(file, 'utf8')) as { history: Array<Record<string, unknown>> }
}

describe('配置校验：行配置缺省也必须能激活', () => {
  it('测试进程的 DSH_HOME 必须被隔离到临时目录（否则会把诊断写进用户真实 ~/.dsh）', () => {
    // 由 tests/mini.ts 在测试进程启动时设置；这条是"别把隔离拆掉"的锁。
    expect(String(process.env.DSH_HOME ?? '').startsWith(tmpdir())).toBe(true)
  })

  it('PLUGIN_VERSION 与 package.json 一致（状态文件靠它确认装的是哪一版）', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { version: string }
    expect(PLUGIN_VERSION).toBe(pkg.version)
  })

  it('Config({}) 通过（每个字段都有默认值，没有任何 .required()）', () => {
    // 1.2.0 在这里翻车：新增字段写成 `.required().default(...)`，而 schemastery 的 required
    // 要求行配置显式提供 → cordis resolveConfig 直接判配置非法 → 插件从不被调用
    // （服务/工具/存储一概不存在，客户端表现为 lxPlayback/* 全 404）。
    // 用户自己写 profile patch（整行替换）时行配置会整体消失，所以"缺省即可用"是硬要求。
    const resolved = Config({}) as Record<string, unknown>
    expect(resolved.providerMode).toBe(DEFAULT_SETTINGS.providerMode)
    expect(resolved.rateLimitPerMinute).toBe(DEFAULT_SETTINGS.rateLimitPerMinute)
    expect(resolved.migrateLegacyDomain).toBe(true)
  })

  it('随包 cordis.patch.yml 的行 config 能通过 Config 校验（键必须都是 schema 认识的）', () => {
    const patch = readFileSync(join(__dirname, '..', '..', 'cordis.patch.yml'), 'utf8')
    const lines = patch.split(/\r?\n/)
    const start = lines.findIndex((l) => /^\s*config:\s*$/.test(l))
    expect(start).toBeGreaterThanOrEqual(0)
    const indent = /^(\s*)/.exec(lines[start] ?? '')?.[1] ?? ''
    const body: string[] = []
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === '') continue
      if (!line.startsWith(`${indent}  `)) break
      if (/^\s*#/.test(line)) continue
      body.push(line.trim())
    }
    expect(body.length).toBeGreaterThan(5)

    const parsed: Record<string, unknown> = {}
    for (const line of body) {
      const [rawKey, ...rest] = line.split(':')
      const key = (rawKey ?? '').trim()
      const raw = rest.join(':').trim().replace(/^['"]|['"]$/g, '')
      parsed[key] = raw.startsWith('[')
        ? (JSON.parse(raw.replace(/'/g, '"')) as unknown)
        : raw === 'true'
          ? true
          : raw === 'false'
            ? false
            : /^-?\d+(\.\d+)?$/.test(raw)
              ? Number(raw)
              : raw
    }
    // 多写/拼错键会被 schemastery 判非法；少写必需字段也会 —— 两种都在这条里锁住
    expect(() => Config(parsed)).not.toThrow()
  })
})

describe('激活路径：可选依赖不能写进 inject', () => {
  it('inject 只声明 tools（storageDomain/skills 是可选的，必须走作用域注入）', () => {
    expect(inject).toEqual(['tools'])
    for (const optional of ['storageDomain', 'storage', 'skills']) {
      expect(inject.includes(optional)).toBe(false)
    }
  })

  it('没有 storageDomain 时插件照样激活：服务与音乐工具都在（内存模式）', async () => {
    await withTempHome(async (home) => {
      const tools: ToolLike[] = []
      const ctx = new Context() as unknown as Record<string, unknown> & { get(key: string): unknown }
      ctx.tools = { register: (t: unknown) => tools.push(t as ToolLike) }
      await apply(ctx as never, { providerMode: 'mock', migrateLegacyDomain: false })

      // 服务存在（客户端不会再 404）——这正是 1.2.0 桌面版缺失的东西
      expect(ctx.get('lxPlayback')).toBeDefined()
      // 音乐工具 7 个（画像工具依赖存储，此时不注册）
      expect(tools.map((t) => t.name).sort()).toEqual(
        ['music_control', 'music_next', 'music_play', 'music_playlist', 'music_prev', 'music_search', 'search_and_play'],
      )

      // 状态文件说明"内存模式"，并且进入时就已落盘（可用来判断插件到底有没有被激活）
      const status = readStatus(home)
      expect(status).toBeDefined()
      const phases = (status?.history ?? []).map((r) => r.phase)
      expect(phases).toContain('enter')
      expect(phases).toContain('ready')
      const ready = (status?.history ?? []).find((r) => r.phase === 'ready')
      expect(ready?.storage).toBe('memory')
      const enter = (status?.history ?? []).find((r) => r.phase === 'enter')
      expect((enter?.services as Record<string, boolean>)?.storageDomain).toBe(false)
    })
  })

  it('存储迟到就绪 → 补挂持久层与画像工具（无需重启插件）', async () => {
    await withTempHome(async (home) => {
      const tools: ToolLike[] = []
      let lateCallback: ((scoped: { storageDomain?: unknown }) => void) | undefined
      const ctx = new Context() as unknown as Record<string, unknown>
      ctx.tools = { register: (t: unknown) => tools.push(t as ToolLike) }
      // 模拟"apply 开始时 storageDomain 还没绑定"：inject 只捕获回调（覆盖 cordis 的实现）
      ctx.inject = (deps: string[], fn: (scoped: { storageDomain?: unknown }) => void) => {
        // apply 里还有一次 ['skills'] 的作用域注入，这里只接管 storageDomain
        if (deps.length === 1 && deps[0] === 'storageDomain') lateCallback = fn
        return undefined
      }
      await apply(ctx as never, { providerMode: 'mock', migrateLegacyDomain: false })

      // 第一阶段：内存模式，7 个工具
      expect(tools).toHaveLength(7)
      expect(typeof lateCallback).toBe('function')

      // 存储就绪 → 触发迟到挂载
      const domain = fakeStorageDomain()
      lateCallback?.({ storageDomain: domain })
      // 等异步挂载完成（domain.open → attach → 注册画像工具）
      for (let i = 0; i < 50 && tools.length < 10; i++) await new Promise((r) => setTimeout(r, 10))

      expect(tools.map((t) => t.name).sort()).toEqual(
        ['music_control', 'music_next', 'music_play', 'music_play_song', 'music_playlist', 'music_prev', 'music_profile', 'music_search', 'music_taste', 'search_and_play'],
      )
      // 状态文件记录为 durable，且注明了迟到挂载
      const status = readStatus(home)
      const ready = (status?.history ?? []).filter((r) => r.phase === 'ready')
      expect(ready.some((r) => r.storage === 'durable')).toBe(true)
      expect(ready.some((r) => String(r.domain ?? '').includes('迟到挂载'))).toBe(true)
    })
  })
})
