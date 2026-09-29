// host 集成测试：用真实 cordis Context 模拟 DSH 注入（tools/storageDomain），
// 验证 apply 全流程：PlaybackService 服务注册、Remote 方法、search_and_play 工具注册与执行。

import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { apply, domainSpec } from '../src/index'
import type { MusicInfo, PlayerState, PluginSettings } from '../src/shared/types'

interface ToolLike {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  description: string
}

/**
 * 提供 storageDomain 服务。
 *
 * cordis 4 起，"给 ctx 直接赋属性"不再算注册服务：插件的 `ctx.inject(['storageDomain'], cb)`
 * 看不到它（而插件也**不能**直接读 `ctx.storageDomain`，那样会抛 without inject）。
 * 所以测试必须走 `ctx.provide()` —— 与 dsh-storage-domain 内部的做法一致。
 */
function provideStorageDomain(ctx: Record<string, unknown>, domain: unknown): void {
  ;(ctx as unknown as { provide(name: string, value: unknown): void }).provide('storageDomain', domain)
}

/** 等存储挂载完成：apply 只同步注册服务与音乐工具，存储与画像是就绪后异步 attach 的。 */
async function waitForTools(tools: ToolLike[], expected: number): Promise<void> {
  for (let i = 0; i < 200 && tools.length < expected; i++) await new Promise((r) => setTimeout(r, 10))
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
  return {
    open: async () => domain,
    tables,
  }
}

describe('host 集成（apply 全流程）', () => {
  it('apply 注册 PlaybackService（lxPlayback）与细粒度音乐工具集', async () => {
    const ctx = new Context() as never as Record<string, unknown> & {
      tools: { register(t: unknown): void }
      storageDomain: { open(spec: unknown): Promise<unknown> }
      logger: { warn(...a: unknown[]): void }
      lxPlayback: {
        getState(): PlayerState
        getSettings(): PluginSettings
        search(req: { query: string; limit?: number }): Promise<{ results: MusicInfo[]; usedSource: string | null }>
        resolveUrl(req: { music: MusicInfo; quality?: string }): Promise<{ url: string }>
        addMusic(musics: MusicInfo[], position: string): PlayerState
        play(req: { index?: number }): PlayerState
        listSources(): Promise<unknown[]>
      }
    }
    const tools: ToolLike[] = []
    ctx.tools = { register: (t) => tools.push(t as ToolLike) }
    provideStorageDomain(ctx as unknown as Record<string, unknown>, fakeStorageDomain())
    ctx.logger = console

    await apply(ctx, { providerMode: 'mock', rateLimitPerMinute: 3, migrateLegacyDomain: false })
    await waitForTools(tools, 10)

    // 1. 服务注册
    expect(typeof ctx.lxPlayback?.getState).toBe('function')

    // 2. 工具注册：细粒度工具集（6 个 music_* + 兼容 search_and_play）+ 画像工具集（3 个）
    expect(tools).toHaveLength(10)
    for (const name of ['music_search', 'music_play', 'music_playlist', 'music_prev', 'music_next', 'music_control', 'search_and_play', 'music_profile', 'music_play_song', 'music_taste']) {
      expect(tools.some((t) => t.name === name)).toBe(true)
    }

    // 3. 播放服务全流程：搜索 → 直链 → 入列 → 播放
    const svc = ctx.lxPlayback!
    const outcome = await svc.search({ query: '晴天', limit: 3 })
    expect(outcome.results.length).toBeGreaterThan(0)
    const music = outcome.results[0]!
    const url = await svc.resolveUrl({ music })
    expect(url.url).toMatch(/^https?:\/\//)
    svc.addMusic(outcome.results, 'tail')
    const st = svc.play({ index: 0 })
    expect(st.status).toBe('playing')
    expect(st.current?.name).toBe('晴天')

    // 4. 设置与音源管理
    expect(svc.getSettings().providerMode).toBe('mock')
    const sources = await svc.listSources()
    expect(Array.isArray(sources)).toBe(true)
  })

  it('实验性开关关闭时不写任何播放行为日志；开启后才写', async () => {
    const ctx = new Context() as never as Record<string, unknown> & {
      tools: { register(t: unknown): void }
      logger: { warn(...a: unknown[]): void }
      lxPlayback: {
        log(entry: Record<string, unknown>): void
        setMemoryConfig(req: { patch: Record<string, unknown> }): Promise<unknown>
      }
    }
    const tools: ToolLike[] = []
    ctx.tools = { register: (t) => tools.push(t as ToolLike) }
    ctx.logger = console
    const domain = fakeStorageDomain()
    provideStorageDomain(ctx as unknown as Record<string, unknown>, domain)

    await apply(ctx, { providerMode: 'mock', migrateLegacyDomain: false })
    await waitForTools(tools, 10)

    const entry = { time: new Date().toISOString(), action: 'play', query: '晴天', limit: 3, autoPlay: true, source: null, resultsCount: 1, playedId: null, latencyMs: 5 }
    // 默认关闭：一条都不记（点歌日志也算音乐行为记录）
    ctx.lxPlayback.log(entry)
    await new Promise((r) => setTimeout(r, 20))
    expect(domain.tables.get('logs')?.size ?? 0).toBe(0)

    // 显式开启后才写
    await ctx.lxPlayback.setMemoryConfig({ patch: { enabled: true } })
    ctx.lxPlayback.log({ ...entry, time: new Date().toISOString() })
    await new Promise((r) => setTimeout(r, 20))
    expect(domain.tables.get('logs')?.size ?? 0).toBe(1)
  })
  it('工具执行：music_play 搜索+直链+播放，且限流生效', async () => {
    const ctx = new Context() as never as Record<string, unknown> & {
      tools: { register(t: unknown): void }
      storageDomain: { open(spec: unknown): Promise<unknown> }
      logger: { warn(...a: unknown[]): void }
      lxPlayback: {
        getState(): PlayerState
        play(req: { index?: number }): PlayerState
        addMusic(musics: MusicInfo[], position: string): PlayerState
      }
    }
    const tools: ToolLike[] = []
    ctx.tools = { register: (t) => tools.push(t as ToolLike) }
    provideStorageDomain(ctx as unknown as Record<string, unknown>, fakeStorageDomain())
    ctx.logger = console
    await apply(ctx, { providerMode: 'mock', rateLimitPerMinute: 2, migrateLegacyDomain: false })
    await waitForTools(tools, 10)

    const findTool = (name: string): ToolLike => {
      const tool = tools.find((t) => t.name === name)
      if (!tool) throw new Error(`tool ${name} 未注册`)
      return tool
    }

    // music_play：搜索 + 直链 + 加入列表 + 播放
    const first = (await findTool('music_play').execute({ query: '周杰伦', limit: 2 }, {})) as {
      played: boolean
      playlistCount: number
      current: { name: string } | null
    }
    expect(first.played).toBe(true)
    expect(first.current?.name).toBe('晴天')
    expect(first.playlistCount).toBe(1)

    // music_search：仅搜索不播放
    const search = (await findTool('music_search').execute({ query: '朴树', limit: 2 }, {})) as { results: unknown[] }
    expect(search.results.length).toBe(2)

    // 限流：搜索类操作第 3 次被拒（2 次/分钟）
    await expect(findTool('music_search').execute({ query: 'Beyond', limit: 1 }, {})).rejects.toThrow(/操作过于频繁/)
  })

  it('无 storageDomain 时仅内存运行', async () => {
    const ctx = new Context() as never as Record<string, unknown> & {
      tools: { register(t: unknown): void }
      logger: { warn(...a: unknown[]): void }
      lxPlayback: { getState(): PlayerState; addMusic(m: MusicInfo[], p: string): PlayerState }
    }
    const tools: ToolLike[] = []
    ctx.tools = { register: (t) => tools.push(t as ToolLike) }
    ctx.logger = console
    await apply(ctx, { providerMode: 'mock', migrateLegacyDomain: false })
    const svc = ctx.lxPlayback!
    svc.addMusic([{ id: 'x', name: 'X', singer: 'Y', source: 'wy', interval: '01:00', meta: { songId: 'x' } }], 'tail')
    expect(svc.getState().playlist).toHaveLength(1)
  })
})

// storage domain 的 schema 是**持久层读边界校验**：任一条存储记录不匹配，整个 domain
// 的 open 就以 invalid-record 失败，插件静默降级为内存存储（播放列表/设置/音源不落盘）。
// 因此每个 schema 必须与代码实际写入的形状逐字段一致 —— 这两条是本项目真实踩过的坑。
describe('storage domain schema 与写入形状一致', () => {
  it('source_order 的记录是裸 string[]（engine/sourceStore.ts 的写入形状）', () => {
    const schema = domainSpec.tables.source_order.valueSchema
    // 实际写入：orderTable.put('order', ['a.js'])
    expect(schema.safeParse(['a.js', 'b.js']).success).toBe(true)
    // 早期错误的 schema 形状：对象包裹（会让旧数据导致 open 失败）
    expect(schema.safeParse({ order: ['a.js'] }).success).toBe(false)
  })

  it('global 保留 playMode（zod 默认丢弃未声明键，漏声明等于播放模式永不持久化）', () => {
    const schema = domainSpec.global.schema
    const parsed = schema.parse({
      playlist: [],
      currentIndex: -1,
      quality: '320k',
      volume: 1,
      mute: false,
      playMode: 'single',
    }) as { playMode?: string }
    expect(parsed.playMode).toBe('single')
  })

  it('sources 记录与 SourceRecord 字段一致', () => {
    const schema = domainSpec.tables.sources.valueSchema
    const ok = schema.safeParse({
      id: 'a.js',
      name: 'A',
      script: '/* x */',
      enabled: true,
      createdAt: '2026-08-15T00:00:00.000Z',
      updatedAt: '2026-08-15T00:00:00.000Z',
    })
    expect(ok.success).toBe(true)
  })
})
