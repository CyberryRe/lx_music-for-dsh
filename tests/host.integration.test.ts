// host 集成测试：用真实 cordis Context 模拟 DSH 注入（tools/storageDomain），
// 验证 apply 全流程：PlaybackService 服务注册、Remote 方法、search_and_play 工具注册与执行。

import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index'
import type { MusicInfo, PlayerState, PluginSettings } from '../src/shared/types'

interface ToolLike {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  description: string
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
    ctx.storageDomain = fakeStorageDomain()
    ctx.logger = console

    await apply(ctx, { providerMode: 'mock', rateLimitPerMinute: 3 })

    // 1. 服务注册
    expect(typeof ctx.lxPlayback?.getState).toBe('function')

    // 2. 工具注册：细粒度工具集（6 个 music_* + 兼容 search_and_play）
    expect(tools).toHaveLength(7)
    for (const name of ['music_search', 'music_play', 'music_playlist', 'music_prev', 'music_next', 'music_control', 'search_and_play']) {
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
    ctx.storageDomain = fakeStorageDomain()
    ctx.logger = console
    await apply(ctx, { providerMode: 'mock', rateLimitPerMinute: 2 })

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
    await apply(ctx, { providerMode: 'mock' })
    const svc = ctx.lxPlayback!
    svc.addMusic([{ id: 'x', name: 'X', singer: 'Y', source: 'wy', interval: '01:00', meta: { songId: 'x' } }], 'tail')
    expect(svc.getState().playlist).toHaveLength(1)
  })
})
