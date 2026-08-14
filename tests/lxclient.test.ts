// lxclient HTTP 客户端测试：超时/重试、搜索编排、直链解析、音源管理（mock fetch）。

import { afterEach, describe, expect, it, vi } from './mini'
import { LxClient, LxHttpError } from '../src/lxclient'
import type { MusicInfo } from '../src/shared/types'

function song(overrides: Partial<MusicInfo> = {}): MusicInfo {
  return {
    id: 's1',
    name: '晴天',
    singer: '周杰伦',
    source: 'wy',
    interval: '04:29',
    meta: { songId: 's1', albumName: '叶惠美', qualitys: [{ type: '128k', size: '3.6M' }, { type: '320k', size: '9.2M' }] },
    ...overrides,
  }
}

function mockFetch(handler: (url: string, init: RequestInit) => Promise<{ status: number; body: unknown }>): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const res = await handler(url, init ?? {})
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      text: async () => JSON.stringify(res.body),
    } as Response
  }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('LxClient.request', () => {
  it('成功请求返回 JSON', async () => {
    mockFetch(async () => ({ status: 200, body: { hello: 'world' } }))
    const client = new LxClient({ baseUrl: 'http://lx:23332' })
    const result = await client.request<{ hello: string }>('/api/status')
    expect(result.hello).toBe('world')
  })

  it('网络错误时重试最多 retries 次后抛 LxHttpError', async () => {
    let calls = 0
    mockFetch(async () => {
      calls += 1
      throw new TypeError('fetch failed')
    })
    const client = new LxClient({ baseUrl: 'http://lx:23332', retries: 2, timeoutMs: 100 })
    await expect(client.request('/api/status')).rejects.toMatchObject({ code: 'network-error' })
    expect(calls).toBe(3) // 1 次 + 2 次重试
  })

  it('超时（AbortError）后重试并给出友好提示', async () => {
    vi.useFakeTimers()
    let calls = 0
    mockFetch(async () => {
      calls += 1
      // 模拟永不返回：fetch 不 resolve，由 AbortController 中断
      return new Promise((_resolve, reject) => {
        // 无法直接监听 signal，这里通过抛出模拟；真正的 abort 由 fetch 实现处理
        reject(new DOMException('aborted', 'AbortError'))
      })
    })
    const client = new LxClient({ baseUrl: 'http://lx:23332', retries: 1, timeoutMs: 10_000 })
    const p = client.request('/api/status')
    // 先注册断言（避免 unhandled rejection），再推进定时器触发超时重试
    const assertion = expect(p).rejects.toMatchObject({ code: 'network-error' })
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(calls).toBe(2)
  })

  it('HTTP 错误返回 LxHttpError 且不重试（4xx/5xx 不重试）', async () => {
    let calls = 0
    mockFetch(async () => {
      calls += 1
      return { status: 500, body: { error: 'boom', code: 500 } }
    })
    const client = new LxClient({ baseUrl: 'http://lx:23332', retries: 2 })
    await expect(client.request('/api/music/search?name=x')).rejects.toMatchObject({ code: '500', status: 500 })
    expect(calls).toBe(1)
  })
})

describe('LxClient.searchWithFallback', () => {
  it('按平台优先级依次尝试，首个有结果的平台胜出', async () => {
    const urls: string[] = []
    mockFetch(async (url) => {
      urls.push(url)
      if (url.includes('source=wy')) return { status: 200, body: [song()] }
      return { status: 200, body: [] }
    })
    const client = new LxClient({ baseUrl: 'http://lx:23332' })
    const outcome = await client.searchWithFallback('晴天', { sources: ['wy', 'tx', 'kg'] })
    expect(outcome.usedSource).toBe('wy')
    expect(outcome.results).toHaveLength(1)
    expect(urls[0]).toContain('source=wy')
    expect(urls).toHaveLength(1)
  })

  it('全部平台失败时返回 attempts（含错误信息）', async () => {
    mockFetch(async () => ({ status: 500, body: { error: '平台挂了' } }))
    const client = new LxClient({ baseUrl: 'http://lx:23332' })
    const outcome = await client.searchWithFallback('晴天', { sources: ['wy', 'tx'] })
    expect(outcome.results).toHaveLength(0)
    expect(outcome.usedSource).toBeNull()
    expect(outcome.attempts.map((a) => a.source)).toEqual(['wy', 'tx'])
    expect(outcome.attempts[0]?.error).toContain('平台挂了')
  })
})

describe('LxClient.resolveUrl', () => {
  it('发送 songInfo + quality，返回直链', async () => {
    let sentBody: unknown = null
    mockFetch(async (url, init) => {
      sentBody = JSON.parse(String(init.body))
      return { status: 200, body: { url: 'https://cdn.example.com/a.mp3', type: '320k', sourceName: 'test-source' } }
    })
    const client = new LxClient({ baseUrl: 'http://lx:23332' })
    const result = await client.resolveUrl(song(), '320k')
    expect(result.url).toBe('https://cdn.example.com/a.mp3')
    expect(sentBody).toMatchObject({ quality: '320k', enableAutoSwitchApiSource: true })
  })
})

describe('LxClient 音源管理', () => {
  it('uploadSource 成功后自动 toggle 启用', async () => {
    const calls: string[] = []
    mockFetch(async (url, _init) => {
      calls.push(url)
      if (url.includes('/upload')) return { status: 200, body: { success: true, id: 'src.js' } }
      if (url.includes('/toggle')) return { status: 200, body: { success: true, enabled: true } }
      return { status: 200, body: {} }
    })
    const client = new LxClient({ baseUrl: 'http://lx:23332' })
    const r = await client.uploadSource('src.js', '/* @name x */ lx.send("inited", {sources:{}});')
    expect(r.success).toBe(true)
    expect(calls.some((u) => u.includes('/upload'))).toBe(true)
    expect(calls.some((u) => u.includes('/toggle'))).toBe(true)
  })

  it('listSources / toggleSource / deleteSource / reorderSources 调用正确端点', async () => {
    const calls: string[] = []
    mockFetch(async (url, init) => {
      calls.push(`${url}|${init.method ?? 'GET'}`)
      if (url.includes('/list')) return { status: 200, body: [{ id: 'a.js', name: 'A', enabled: true }] }
      return { status: 200, body: { success: true } }
    })
    const client = new LxClient({ baseUrl: 'http://lx:23332' })
    const list = await client.listSources()
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe('a.js')
    await client.toggleSource('a.js', false)
    await client.deleteSource('a.js')
    await client.reorderSources(['a.js', 'b.js'])
    expect(calls.some((c) => c.includes('/api/custom-source/list'))).toBe(true)
    expect(calls.some((c) => c.includes('/api/custom-source/toggle'))).toBe(true)
    expect(calls.some((c) => c.includes('/api/custom-source/delete'))).toBe(true)
    expect(calls.some((c) => c.includes('/api/custom-source/reorder'))).toBe(true)
  })
})

describe('LxHttpError', () => {
  it('携带 status/code/attempts', () => {
    const err = new LxHttpError('x', 500, '500', [{ name: 'a' }])
    expect(err).toBeInstanceOf(Error)
    expect(err.status).toBe(500)
    expect(err.code).toBe('500')
    expect(err.attempts).toHaveLength(1)
  })
})
