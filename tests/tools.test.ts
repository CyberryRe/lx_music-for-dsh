// 细粒度音乐工具集测试：注册（7 个工具）、搜索、播放、播放列表管理、上下首、控制、
// 防刷限流、点歌日志、输出渲染、兼容入口 search_and_play。

import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { PlaybackService } from '../src/playback'
import { SlidingWindowRateLimiter } from '../src/ratelimit'
import { registerMusicTools } from '../src/tools'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import type { PlayLogEntry } from '../src/shared/types'

interface ToolLike {
  name: string
  execute(args: unknown, exec: unknown): Promise<unknown>
  output: { render(args: unknown, value: unknown): unknown[] }
  description: string
  parameters: unknown
}

function makeHarness(options: { rateLimit?: number; now?: () => number } = {}) {
  const logs: PlayLogEntry[] = []
  const now = options.now ?? Date.now
  const rateLimiter = new SlidingWindowRateLimiter({ maxCalls: options.rateLimit ?? 6, windowMs: 60_000 })
  const service = new PlaybackService(new Context(), {
    settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' },
    rateLimiter,
    onLog: (e) => logs.push(e),
  })
  const tools: ToolLike[] = []
  registerMusicTools({ tools: { register: (t) => tools.push(t as ToolLike) } }, { service, now })
  const byName = (name: string): ToolLike => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`tool ${name} 未注册（已注册：${tools.map((t) => t.name).join(', ')}）`)
    return tool
  }
  return { service, tools, logs, rateLimiter, byName }
}

describe('音乐工具集注册', () => {
  it('注册 7 个细粒度工具', () => {
    const { tools } = makeHarness()
    expect(tools).toHaveLength(7)
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual(['music_control', 'music_next', 'music_play', 'music_playlist', 'music_prev', 'music_search', 'search_and_play'])
  })

  it('music_search 参数 schema 完整（query 必填）', () => {
    const { byName } = makeHarness()
    const tool = byName('music_search')
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' } },
    })
  })
})

describe('music_search 搜索', () => {
  it('仅搜索不播放，返回结果并记录 search 日志', async () => {
    const { byName, service, logs } = makeHarness()
    const out = (await byName('music_search').execute({ query: '晴天', limit: 3 }, {})) as {
      results: Array<{ name: string; url: string }>
      usedSource: string
      note: string
    }
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results[0]?.name).toBe('晴天')
    expect(out.results[0]?.url).toBe('') // 默认不解析直链
    const st = service.getState()
    expect(st.playlist).toHaveLength(0) // 不加入列表
    expect(st.status).toBe('stoped') // 不播放
    expect(logs.at(-1)?.action).toBe('search')
  })

  it('with_url=true 解析直链预览', async () => {
    const { byName } = makeHarness()
    const out = (await byName('music_search').execute({ query: '晴天', limit: 1, with_url: true }, {})) as {
      results: Array<{ url: string }>
    }
    expect(out.results[0]?.url).toMatch(/^https?:\/\//)
  })

  it('支持歌手过滤与指定平台', async () => {
    const { byName } = makeHarness()
    const out = (await byName('music_search').execute({ query: '花儿', singer: '朴树', limit: 5 }, {})) as {
      results: Array<{ name: string; singer: string }>
    }
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results.every((r) => r.name === '那些花儿' && r.singer === '朴树')).toBe(true)
  })

  it('无结果抛友好错误并记录日志', async () => {
    const { byName, logs } = makeHarness()
    await expect(byName('music_search').execute({ query: '不存在的歌xyz' }, {})).rejects.toThrow(/未找到/)
    expect(logs.at(-1)?.action).toBe('search')
    expect(logs.at(-1)?.error).toContain('未找到')
  })

  it('空 query 抛错', async () => {
    const { byName } = makeHarness()
    await expect(byName('music_search').execute({ query: '  ' }, {})).rejects.toThrow('query 不能为空')
  })
})

describe('music_play 播放', () => {
  it('query：搜索 → 解析直链 → 加入列表 → 播放', async () => {
    const { byName, service, logs } = makeHarness()
    const out = (await byName('music_play').execute({ query: '晴天' }, {})) as {
      played: boolean
      playlistPosition: number
      playlistCount: number
      current: { name: string } | null
      note: string
    }
    expect(out.played).toBe(true)
    expect(out.playlistPosition).toBe(0)
    expect(out.playlistCount).toBe(1)
    expect(out.current?.name).toBe('晴天')
    const st = service.getState()
    expect(st.playlist).toHaveLength(1)
    expect(st.status).toBe('playing')
    expect(logs.at(-1)?.action).toBe('play')
    expect(logs.at(-1)?.playedId).toBe(st.current?.id)
  })

  it('query + result_index 播放第 N 首', async () => {
    const { byName } = makeHarness()
    const out = (await byName('music_play').execute({ query: '周杰伦', result_index: 1, source: 'wy' }, {})) as {
      current: { name: string } | null
    }
    expect(out.current?.name).toBe('七里香')
  })

  it('auto_play=false 仅加入列表', async () => {
    const { byName, service } = makeHarness()
    const out = (await byName('music_play').execute({ query: '晴天', auto_play: false }, {})) as { played: boolean; playlistCount: number }
    expect(out.played).toBe(false)
    expect(out.playlistCount).toBe(1)
    expect(service.getState().status).toBe('paused')
  })

  it('index：直接播放播放列表第 N 首（不限流）', async () => {
    const { byName, service, rateLimiter } = makeHarness()
    service.addMusic([{ id: 'a', name: 'A', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'a' } }], 'tail')
    service.addMusic([{ id: 'b', name: 'B', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'b' } }], 'tail')
    const before = rateLimiter.count(Date.now())
    const out = (await byName('music_play').execute({ index: 1 }, {})) as { current: { name: string } | null }
    expect(out.current?.name).toBe('B')
    expect(rateLimiter.count(Date.now())).toBe(before) // 序号播放不消耗搜索配额
  })

  it('index 越界抛错', async () => {
    const { byName } = makeHarness()
    await expect(byName('music_play').execute({ index: 5 }, {})).rejects.toThrow(/索引越界/)
  })

  it('query 与 index 都缺省时抛错', async () => {
    const { byName } = makeHarness()
    await expect(byName('music_play').execute({}, {})).rejects.toThrow(/query.*index/)
  })
})

describe('music_playlist 播放列表管理', () => {
  it('add：搜索并加入队尾', async () => {
    const { byName, service, logs } = makeHarness()
    const out = (await byName('music_playlist').execute({ action: 'add', query: '朴树', limit: 2 }, {})) as {
      action: string
      count: number
      playlist: Array<{ name: string }>
    }
    expect(out.action).toBe('add')
    expect(out.count).toBe(2)
    expect(out.playlist.map((m) => m.name)).toEqual(['平凡之路', '生如夏花'])
    expect(service.getState().playlist).toHaveLength(2)
    expect(logs.at(-1)?.action).toBe('playlist.add')
  })

  it('list：返回当前列表摘要', async () => {
    const { byName, service } = makeHarness()
    service.addMusic([{ id: 'a', name: 'A', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'a' } }], 'tail')
    service.play({ index: 0 })
    const out = (await byName('music_playlist').execute({ action: 'list' }, {})) as {
      count: number
      currentIndex: number
      playlist: Array<{ index: number }>
    }
    expect(out.count).toBe(1)
    expect(out.currentIndex).toBe(0)
    expect(out.playlist[0]?.index).toBe(0)
  })

  it('remove：按 index 与按 id 均可', async () => {
    const { byName, service } = makeHarness()
    service.addMusic([{ id: 'a', name: 'A', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'a' } }], 'tail')
    service.addMusic([{ id: 'b', name: 'B', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'b' } }], 'tail')
    await byName('music_playlist').execute({ action: 'remove', index: 0 }, {})
    expect(service.getState().playlist.map((m) => m.id)).toEqual(['b'])
    await byName('music_playlist').execute({ action: 'remove', id: 'b' }, {})
    expect(service.getState().playlist).toHaveLength(0)
  })

  it('clear / export', async () => {
    const { byName, service } = makeHarness()
    service.addMusic([{ id: 'a', name: 'A', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'a' } }], 'tail')
    const exp = (await byName('music_playlist').execute({ action: 'export' }, {})) as { text: string }
    expect(exp.text).toContain('A - X')
    await byName('music_playlist').execute({ action: 'clear' }, {})
    expect(service.getState().playlist).toHaveLength(0)
  })
})

describe('music_prev / music_next 切歌', () => {
  function seeded() {
    const h = makeHarness()
    h.service.addMusic([{ id: 'a', name: 'A', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'a' } }], 'tail')
    h.service.addMusic([{ id: 'b', name: 'B', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'b' } }], 'tail')
    h.service.addMusic([{ id: 'c', name: 'C', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'c' } }], 'tail')
    h.service.play({ index: 0 })
    return h
  }

  it('next 前进 / prev 回退', async () => {
    const { byName } = seeded()
    const n = (await byName('music_next').execute({}, {})) as { playlistPosition: number }
    expect(n.playlistPosition).toBe(1)
    const p = (await byName('music_prev').execute({}, {})) as { playlistPosition: number }
    expect(p.playlistPosition).toBe(0)
  })

  it('空列表抛错并记录日志', async () => {
    const { byName, logs } = makeHarness()
    await expect(byName('music_next').execute({}, {})).rejects.toThrow('播放列表为空')
    expect(logs.at(-1)?.action).toBe('next')
    expect(logs.at(-1)?.error).toContain('播放列表为空')
  })
})

describe('music_control 播放控制', () => {
  it('toggle / pause / resume / seek / volume / quality / playMode', async () => {
    const { byName, service } = makeHarness()
    service.addMusic([{ id: 'a', name: 'A', singer: 'X', source: 'wy', interval: '01:00', meta: { songId: 'a' } }], 'tail')
    service.play({ index: 0 })

    await byName('music_control').execute({ action: 'pause' }, {})
    expect(service.getState().status).toBe('paused')

    await byName('music_control').execute({ action: 'resume' }, {})
    expect(service.getState().status).toBe('playing')

    const toggled = (await byName('music_control').execute({ action: 'toggle' }, {})) as { status: string }
    expect(toggled.status).toBe('paused')

    await byName('music_control').execute({ action: 'seek', seconds: 30 }, {})
    expect(service.getState().progress).toBe(30)

    await byName('music_control').execute({ action: 'volume', volume: 0.3 }, {})
    expect(service.getState().volume).toBe(0.3)

    await byName('music_control').execute({ action: 'quality', quality: 'flac' }, {})
    expect(service.getState().quality).toBe('flac')

    const mode = (await byName('music_control').execute({ action: 'playMode', play_mode: 'shuffle' }, {})) as { playMode: string }
    expect(mode.playMode).toBe('shuffle')
    expect(service.getState().playMode).toBe('shuffle')
  })

  it('参数缺失/非法时抛错', async () => {
    const { byName } = makeHarness()
    await expect(byName('music_control').execute({ action: 'seek' }, {})).rejects.toThrow(/seconds/)
    await expect(byName('music_control').execute({ action: 'volume', volume: 2 }, {})).rejects.toThrow(/volume/)
    await expect(byName('music_control').execute({ action: 'playMode' }, {})).rejects.toThrow(/play_mode/)
  })
})

describe('防刷限流与日志', () => {
  it('网络搜索类操作共享限流（超限拒绝并提示）', async () => {
    let t = 0
    const { byName, rateLimiter } = makeHarness({ rateLimit: 2, now: () => t })
    await byName('music_search').execute({ query: '晴天', limit: 1 }, {})
    t += 1000
    await byName('music_play').execute({ query: '七里香' }, {})
    t += 1000
    await expect(byName('music_playlist').execute({ action: 'add', query: '稻香' }, {})).rejects.toThrow(/操作过于频繁/)
    expect(rateLimiter.count(t)).toBe(2)
  })

  it('每分钟窗口滑动后恢复', async () => {
    let t = 0
    const { byName } = makeHarness({ rateLimit: 1, now: () => t })
    await byName('music_search').execute({ query: '晴天', limit: 1 }, {})
    t += 61_000
    const out = (await byName('music_search').execute({ query: '晴天', limit: 1 }, {})) as { results: unknown[] }
    expect(out.results.length).toBeGreaterThan(0)
  })

  it('日志记录 action 字段', async () => {
    const { byName, logs } = makeHarness()
    await byName('music_control').execute({ action: 'volume', volume: 0.5 }, {})
    expect(logs.at(-1)?.action).toBe('control.volume')
  })
})

describe('兼容入口 search_and_play', () => {
  it('一步点歌：搜索 → 直链预览 → 加入列表 → 播放第一首', async () => {
    const { byName, service, logs } = makeHarness()
    const tool = byName('search_and_play')
    const out = (await tool.execute({ query: '晴天', limit: 3 }, {})) as {
      results: Array<{ name: string; url: string }>
      played: boolean
      playlistPosition: number
    }
    expect(out.played).toBe(true)
    expect(out.playlistPosition).toBe(0)
    expect(out.results[0]?.name).toBe('晴天')
    expect(out.results[0]?.url).toMatch(/^https?:\/\//) // 直链预览
    expect(service.getState().status).toBe('playing')
    expect(logs.at(-1)?.action).toBe('search_and_play')
  })

  it('auto_play=false 仅加入列表', async () => {
    const { byName, service } = makeHarness()
    const out = (await byName('search_and_play').execute({ query: '周杰伦', limit: 2, auto_play: false }, {})) as {
      played: boolean
      playlistPosition: number
    }
    expect(out.played).toBe(false)
    expect(service.getState().status).toBe('paused')
    expect(service.getState().playlist.length).toBeGreaterThan(0)
  })
})

describe('工具输出渲染', () => {
  it('music_search render 生成人类可读文本', async () => {
    const { byName } = makeHarness()
    const out = await byName('music_search').execute({ query: '晴天', limit: 1 }, {})
    const rendered = byName('music_search').output.render({ query: '晴天' }, out)
    const first = rendered[0] as { type?: string; text?: string }
    expect(first).toMatchObject({ type: 'text' })
    expect(String(first?.text)).toContain('晴天')
  })

  it('music_play render 包含当前曲目', async () => {
    const { byName } = makeHarness()
    const out = await byName('music_play').execute({ query: '晴天' }, {})
    const rendered = byName('music_play').output.render({}, out)
    const first = rendered[0] as { text?: string }
    expect(String(first?.text)).toContain('晴天')
  })
})
