// mock provider 测试：搜索（关键词/歌手/平台）、直链解析。

import { describe, expect, it } from './mini'
import { MockProvider } from '../src/mock'

const provider = new MockProvider({ latencyMs: 0 })

describe('MockProvider.search', () => {
  it('按关键词匹配歌名/歌手', async () => {
    const r = await provider.search('晴天')
    expect(r.usedSource).toBe('wy')
    expect(r.results[0]?.name).toBe('晴天')
    expect(r.results[0]?.singer).toBe('周杰伦')
    expect(r.results[0]?.meta.qualitys?.map((q) => q.type)).toContain('320k')
  })

  it('支持歌手过滤', async () => {
    const r = await provider.search('花', { singer: '朴树' })
    expect(r.results.every((m) => m.singer === '朴树')).toBe(true)
    expect(r.results.length).toBeGreaterThan(0)
  })

  it('按平台优先级搜索，去重', async () => {
    const r = await provider.search('Lemon', { sources: ['mg', 'wy'], limit: 10 })
    expect(r.usedSource).toBe('mg')
    // Lemon 与 Lemon Tree 同名不同歌，但都在 mg
    const names = r.results.map((m) => m.name)
    expect(names).toContain('Lemon')
    expect(names).toContain('Lemon Tree')
    // 去重：同一 name|singer 只出现一次
    const dedupe = new Set(r.results.map((m) => `${m.name}|${m.singer}`))
    expect(dedupe.size).toBe(r.results.length)
  })

  it('无结果时返回空与 attempts', async () => {
    const r = await provider.search('不存在的歌xyz')
    expect(r.results).toHaveLength(0)
    expect(r.usedSource).toBeNull()
    expect(r.attempts.length).toBeGreaterThan(0)
  })

  it('limit 生效', async () => {
    const r = await provider.search('的', { limit: 2 })
    expect(r.results.length).toBeLessThanOrEqual(2)
  })
})

describe('MockProvider.resolveUrl', () => {
  it('返回可播放直链与音质', async () => {
    const r = await provider.search('晴天')
    const url = await provider.resolveUrl(r.results[0]!, '320k')
    expect(url.url).toMatch(/^https?:\/\//)
    expect(url.type).toBe('320k')
    expect(url.sourceName).toBe('mock')
  })
})

