// Client 播放引擎竞态回归测试。
//
// 被锁的故障（旧实现，src/ui/store.ts）：
//   「我明明换了一首歌，但播放的仍然是之前播放的歌的流」。
//   机制：`loadTrack()` 开头 `if (this.loadingTrack) return` —— 解析**期间**发生的切歌请求
//   被直接丢弃；解析返回后又**无条件** `this.audio.src = resolved.url`，于是旧歌的直链被贴到
//   刚切过去的曲目上；又因为 `snapshot.state` 早就是新歌，下一轮轮询的 `trackChanged` 判定为
//   false，于是**永久卡在**"界面是新歌、声音是旧歌"。
//
// 写法上的三条自我约束（第一版这三条都违反了，导致假失败，故记在这里）：
//   1. **不用 setTimeout 假装等待**：加载是异步的，必须有一个明确的"已稳定"信号。
//      这里用 `store.settleLoaded()`（内部 `await pending`），不再靠 tick 数量碰运气；
//   2. **不依赖 `store.start()`**：它会拉起 500ms 轮询与 `refreshAll`，假 remote 的
//      `getState` 返回"无曲目"，轮询会在断言中途把状态改回去。这里只 stub `Audio`
//      并直接驱动 `syncState`（真正的生产入口是 refreshAll/sync/applyState，三者都走它）；
//   3. **同一首歌可能被解析多次**：解析函数按 id 累积所有等待中的 promise，
//      只记最后一个会让先前那次永远悬着（假失败）。

import { describe, expect, it, vi } from './mini'
import { LxStore, type LxRemote } from '../src/ui/store'
import { DEFAULT_SETTINGS, type MusicInfo, type PlayerState, type Quality } from '../src/shared/types'

/** 假 Audio：只实现 store 用到的部分，并允许手动触发事件。 */
class FakeAudio {
  src = ''
  volume = 1
  paused = true
  currentTime = 0
  duration = 0
  preload = ''
  private listeners = new Map<string, Set<() => void>>()

  addEventListener(type: string, fn: () => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set())
    this.listeners.get(type)!.add(fn)
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn)
  }
  async play(): Promise<void> {
    this.paused = false
  }
  pause(): void {
    this.paused = true
  }
  dispatch(type: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn()
  }
}

function music(id: string, name: string): MusicInfo {
  return {
    id,
    name,
    singer: '测试歌手',
    source: 'wy',
    interval: '03:00',
    meta: { songId: id, qualitys: [{ type: '320k', size: '9M' }] },
  }
}

function state(current: MusicInfo | null, status: PlayerState['status'], version: number, quality: Quality = '320k'): PlayerState {
  return {
    playlist: current ? [current] : [],
    currentIndex: current ? 0 : -1,
    status,
    progress: 0,
    duration: 180,
    current,
    quality,
    volume: 1,
    mute: false,
    playMode: 'list',
    version,
  }
}

/**
 * 受控直链解析：由测试决定"什么时候返回什么"。
 * `pending` 按曲目 id 累积所有等待中的 promise —— 同一首歌被解析两次时两次都要能结算。
 */
function deferredResolve() {
  const pending = new Map<string, Array<{ resolve: (url: string) => void; reject: (err: Error) => void }>>()
  const calls: string[] = []
  const fn = (req: { music: MusicInfo }): Promise<{ url: string; type: Quality }> => {
    calls.push(req.music.id)
    return new Promise((resolve, reject) => {
      const list = pending.get(req.music.id) ?? []
      list.push({ resolve: (url: string) => resolve({ url, type: '320k' }), reject })
      pending.set(req.music.id, list)
    })
  }
  return {
    fn,
    calls,
    count: (id: string): number => (pending.get(id) ?? []).length,
    settleAll: (id: string, url: string): void => {
      for (const entry of pending.get(id) ?? []) entry.resolve(url)
    },
    rejectAll: (id: string, err: Error): void => {
      for (const entry of pending.get(id) ?? []) entry.reject(err)
    },
  }
}

/** 假 remote：只有 resolveUrl / next / reportProgress 会被这些用例碰到。 */
function fakeRemote(resolveUrl: ReturnType<typeof deferredResolve>['fn'], overrides: Partial<LxRemote> = {}): LxRemote {
  const remote = {
    getState: async () => state(null, 'stoped', 0),
    getSettings: async () => DEFAULT_SETTINGS,
    listSources: async () => [],
    resolveUrl,
    getTasteProfile: async () => ({
      enabled: false,
      onboarded: true,
      snoozed: false,
      summary: '',
      artists: [],
      tracks: [],
      sampleSize: 0,
      config: null,
    }),
    getTasteEvents: async () => [],
    next: async () => state(null, 'stoped', 0),
    reportProgress: async () => undefined,
    ...overrides,
  }
  return remote as unknown as LxRemote
}

/**
 * 建 store 并接好音频，但**不调用 start()**（避免轮询与 refreshAll 干扰）。
 * 这里只 stub `Audio`；不 stub 其它全局，`vi.unstubAllGlobals()` 统一收尾。
 */
function harness(resolveUrl: ReturnType<typeof deferredResolve>['fn'], overrides: Partial<LxRemote> = {}) {
  const audio = new FakeAudio()
  vi.stubGlobal('Audio', function FakeAudioCtor() {
    return audio
  })
  const remote = fakeRemote(resolveUrl, overrides)
  const store = new LxStore(remote)
  // 生产里 audio 由 start() 创建；这里手动接上同一个实例（start() 还会挂轮询，不要）
  ;(store as unknown as { audio: FakeAudio }).audio = audio
  const sync = (s: PlayerState): void => {
    ;(store as unknown as { syncState(v: PlayerState): void }).syncState(s)
  }
  return { store, audio, sync }
}

describe('client 切歌竞态：旧歌的流绝不能落到新歌上', () => {
  it('解析期间切歌：只有最新一次的直链会写入 audio（过期结果被丢弃）', async () => {
    const d = deferredResolve()
    const a = music('a', '第一首')
    const b = music('b', '第二首')
    const { store, audio, sync } = harness(d.fn)
    try {
      sync(state(a, 'playing', 1))
      expect(d.calls).toEqual(['a'])

      // A 还在解析，用户切到 B
      sync(state(b, 'playing', 2))
      expect(d.calls).toEqual(['a', 'b'])

      // B（当前曲目）的直链返回 → 落地
      d.settleAll('b', 'https://example.com/b.mp3')
      await store.settleLoaded()
      expect(audio.src).toBe('https://example.com/b.mp3')
      expect(audio.paused).toBe(false)

      // A 的直链「迟到」返回：它已过期，绝不能把 audio 改回旧流
      d.settleAll('a', 'https://example.com/a.mp3')
      await store.settleLoaded()
      expect(audio.src).toBe('https://example.com/b.mp3')
      // 也不该因为这次过期返回而再解析一遍（每次切歌最多一次有效解析）
      expect(d.calls).toEqual(['a', 'b'])
    } finally {
      store.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('B 落地后，A 的迟到结果不能把它覆盖回旧流（就是"声音还是上一首"）', async () => {
    const d = deferredResolve()
    const a = music('a', '第一首')
    const b = music('b', '第二首')
    const { store, audio, sync } = harness(d.fn)
    try {
      sync(state(a, 'playing', 1))
      sync(state(b, 'playing', 2))

      // B 先返回并落地
      d.settleAll('b', 'https://example.com/b.mp3')
      await store.settleLoaded()
      expect(audio.src).toBe('https://example.com/b.mp3')

      // A 随后返回：必须被丢弃，audio.src 保持 B
      d.settleAll('a', 'https://example.com/a.mp3')
      await store.settleLoaded()
      expect(audio.src).toBe('https://example.com/b.mp3')
      // 并且不该因为这次过期返回而额外解析（每次切歌最多一次有效解析）
      expect(d.calls.filter((id) => id === 'b').length).toBe(1)
    } finally {
      store.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('过期请求的失败不会影响正在播的那首（不误跳歌）', async () => {
    const d = deferredResolve()
    const a = music('a', '第一首')
    const b = music('b', '第二首')
    let nextCalled = 0
    const { store, audio, sync } = harness(d.fn, {
      next: async () => {
        nextCalled += 1
        return state(null, 'stoped', 3)
      },
    })
    try {
      sync(state(a, 'playing', 1))
      sync(state(b, 'playing', 2))

      // A 解析失败（已过期）→ 不许跳歌、不许写 error
      d.rejectAll('a', new Error('A 音源挂了'))
      await store.settleLoaded()
      expect(nextCalled).toBe(0)
      expect(store.getSnapshot().error).toBeNull()

      // B 正常落地
      d.settleAll('b', 'https://example.com/b.mp3')
      await store.settleLoaded()
      expect(audio.src).toBe('https://example.com/b.mp3')
      expect(nextCalled).toBe(0)
    } finally {
      store.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('同一首 paused→playing 不重复解析直链', async () => {
    const d = deferredResolve()
    const a = music('a', '第一首')
    const { store, audio, sync } = harness(d.fn)
    try {
      sync(state(a, 'paused', 1))
      d.settleAll('a', 'https://example.com/a.mp3')
      await store.settleLoaded()
      expect(d.calls).toEqual(['a'])

      // 恢复播放：同一首、同一音质 → 不该再打一次音源脚本
      sync(state(a, 'playing', 2))
      await store.settleLoaded()
      expect(d.calls).toEqual(['a'])
      expect(audio.src).toBe('https://example.com/a.mp3')
    } finally {
      store.dispose()
      vi.unstubAllGlobals()
    }
  })

  it('当前曲目解析失败：报错并推进到下一首，而且不每轮重试同一首', async () => {
    const d = deferredResolve()
    const a = music('a', '第一首')
    const b = music('b', '第二首')
    let nextCalled = 0
    const { store, audio, sync } = harness(d.fn, {
      next: async () => {
        nextCalled += 1
        return state(b, 'playing', 3)
      },
    })
    try {
      sync(state(a, 'playing', 1))
      d.rejectAll('a', new Error('未找到支持 wy 平台'))
      await store.settleLoaded()

      expect(nextCalled).toBe(1)
      expect(String(store.getSnapshot().error ?? '')).toContain('未找到支持')
      expect(audio.src).toBe('')

      // 关键：host 还没切过来之前再同步几次，也不能反复重试同一首（旧实现会刷成风暴）
      sync(state(a, 'playing', 1))
      sync(state(a, 'playing', 1))
      await store.settleLoaded()
      expect(d.calls.filter((id) => id === 'a').length).toBe(1)
      expect(nextCalled).toBe(1)
    } finally {
      store.dispose()
      vi.unstubAllGlobals()
    }
  })
})
