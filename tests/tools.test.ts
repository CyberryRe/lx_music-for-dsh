// search_and_play 工具测试：搜索+直链+加入列表+自动播放、防刷限流、点歌日志、auto_play=false。

import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { PlaybackService } from '../src/playback'
import { SlidingWindowRateLimiter } from '../src/ratelimit'
import { registerSearchAndPlayTool } from '../src/tools'
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
  registerSearchAndPlayTool({ tools: { register: (t) => tools.push(t as ToolLike) } }, { service, now })
  return { service, tools, logs, rateLimiter }
}

describe('search_and_play 工具注册', () => {
  it('注册名为 search_and_play 且参数 schema 完整', () => {
    const { tools } = makeHarness()
    expect(tools).toHaveLength(1)
    const tool = tools[0]!
    expect(tool.name).toBe('search_and_play')
    expect(tool.description).toContain('点歌')
    // defineTool 会把 parameters 规范化为 JSON Schema（properties + required）
    expect(tool.parameters).toMatchObject({
      type: 'object',
      required: ['query'],
      properties: { query: { type: 'string' } },
    })
  })
})

describe('search_and_play 执行', () => {
  it('auto_play=true：搜索 → 直链预览 → 加入列表 → 播放第一首', async () => {
    const { tools, service } = makeHarness()
    const tool = tools[0]!
    const out = (await tool.execute({ query: '晴天', limit: 3 }, {})) as {
      results: Array<{ name: string; url: string }>
      played: boolean
      playlistPosition: number
    }
    expect(out.played).toBe(true)
    expect(out.playlistPosition).toBe(0)
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results[0]?.name).toBe('晴天')
    expect(out.results[0]?.url).toMatch(/^https?:\/\//) // 直链预览
    const st = service.getState()
    expect(st.playlist.length).toBeGreaterThan(0)
    expect(st.status).toBe('playing')
    expect(st.current?.name).toBe('晴天')
  })

  it('auto_play=false：仅加入列表不播放', async () => {
    const { tools, service } = makeHarness()
    const tool = tools[0]!
    const out = (await tool.execute({ query: '周杰伦', limit: 2, auto_play: false }, {})) as {
      played: boolean
      playlistPosition: number
    }
    expect(out.played).toBe(false)
    expect(service.getState().status).toBe('paused')
    expect(service.getState().playlist.length).toBeGreaterThan(0)
  })

  it('指定平台 source 生效', async () => {
    const { tools } = makeHarness()
    const tool = tools[0]!
    // mock 数据中「夜曲」仅存在于 kg 平台
    const out = (await tool.execute({ query: '夜曲', source: 'kg' }, {})) as { results: Array<{ source: string }> }
    expect(out.results.length).toBeGreaterThan(0)
    expect(out.results.every((r) => r.source === 'kg')).toBe(true)
  })

  it('无结果时抛友好错误', async () => {
    const { tools, logs } = makeHarness()
    const tool = tools[0]!
    await expect(tool.execute({ query: '不存在的歌xyz' }, {})).rejects.toThrow(/未找到/)
    expect(logs.at(-1)?.error).toContain('未找到')
  })

  it('空 query 抛错', async () => {
    const { tools } = makeHarness()
    const tool = tools[0]!
    await expect(tool.execute({ query: '  ' }, {})).rejects.toThrow('query 不能为空')
  })
})

describe('search_and_play 防刷与日志', () => {
  it('超过限流次数后拒绝并提示重试时间', async () => {
    let t = 0
    const { tools, rateLimiter } = makeHarness({ rateLimit: 2, now: () => t })
    const tool = tools[0]!
    await tool.execute({ query: '晴天', limit: 1 }, {})
    t += 1000
    await tool.execute({ query: '七里香', limit: 1 }, {})
    t += 1000
    await expect(tool.execute({ query: '稻香', limit: 1 }, {})).rejects.toThrow(/点歌过于频繁/)
    expect(rateLimiter.count(t)).toBe(2)
  })

  it('每分钟窗口滑动后恢复', async () => {
    let t = 0
    const { tools } = makeHarness({ rateLimit: 1, now: () => t })
    const tool = tools[0]!
    await tool.execute({ query: '晴天', limit: 1 }, {})
    t += 61_000
    const out = (await tool.execute({ query: '七里香', limit: 1 }, {})) as { results: unknown[] }
    expect(out.results.length).toBeGreaterThan(0)
  })

  it('每次调用记录点歌日志（含 query/结果数/延迟）', async () => {
    let t = 0
    const { tools, logs } = makeHarness({ now: () => t })
    const tool = tools[0]!
    await tool.execute({ query: '周杰伦', limit: 2 }, {})
    expect(logs).toHaveLength(1)
    const log = logs[0]!
    expect(log.query).toBe('周杰伦')
    expect(log.resultsCount).toBeGreaterThan(0)
    expect(log.autoPlay).toBe(true)
    expect(log.playedId).toBeTruthy()
    expect(log.latencyMs).toBeGreaterThanOrEqual(0)
  })
})

describe('search_and_play 输出渲染', () => {
  it('render 生成人类可读文本', async () => {
    const { tools } = makeHarness()
    const tool = tools[0]!
    const out = await tool.execute({ query: '晴天', limit: 1 }, {})
    const rendered = tool.output.render({ query: '晴天' }, out)
    const first = rendered[0] as { type?: string; text?: string }
    expect(first).toMatchObject({ type: 'text' })
    expect(String(first?.text)).toContain('晴天')
  })
})

