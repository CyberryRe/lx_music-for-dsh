// 系统媒体控件桥（src/ui/mediaSession.ts）单测。
//
// 为什么值得单测：SMTC 面板**没有回读 API**，如果桥把 title/artwork 写错了（或压根没写），
// 在 Windows 上只能靠肉眼看系统面板才能发现。这里用假的 `navigator.mediaSession` 把
// "推了什么"钉死，并把几个会真实抛错的边界（duration=0、position>duration）覆盖掉。

import { afterEach, describe, expect, it, vi } from './mini'
import { MediaSessionBridge, coverArtwork, resizeCoverUrl } from '../src/ui/mediaSession'
import type { PlayerState, SmtcStatus } from '../src/shared/types'

interface FakeCall { method: string; args: unknown[] }

interface FakeSession {
  metadata: unknown
  playbackState: string
  handlers: Map<string, ((details: Record<string, unknown>) => void) | null>
  calls: FakeCall[]
  throwOn: Set<string>
}

function createFakeSession(): FakeSession {
  const session: FakeSession = {
    metadata: undefined,
    playbackState: 'none',
    handlers: new Map(),
    calls: [],
    throwOn: new Set(),
  }
  return session
}

function installGlobals(session: FakeSession | null): void {
  const mediaSession = session
    ? {
      get metadata() { return session.metadata },
      set metadata(v: unknown) { session.calls.push({ method: 'metadata', args: [v] }); session.metadata = v },
      get playbackState() { return session.playbackState },
      set playbackState(v: string) { session.calls.push({ method: 'playbackState', args: [v] }); session.playbackState = v },
      setActionHandler: (action: string, handler: unknown) => {
        if (session.throwOn.has(`handler:${action}`)) throw new TypeError(`not supported: ${action}`)
        session.calls.push({ method: 'setActionHandler', args: [action, handler] })
        session.handlers.set(action, handler as (d: Record<string, unknown>) => void)
      },
      setPositionState: (state: Record<string, unknown>) => {
        if (session.throwOn.has('position')) throw new TypeError('bad position state')
        session.calls.push({ method: 'setPositionState', args: [state] })
      },
    }
    : undefined
  Object.defineProperty(globalThis, 'navigator', { value: { mediaSession }, configurable: true, writable: true })
  Object.defineProperty(globalThis, 'MediaMetadata', {
    value: class {
      constructor(init: Record<string, unknown>) { Object.assign(this, init) }
    },
    configurable: true,
    writable: true,
  })
}

interface FakeStore {
  listeners: Set<() => void>
  state: Partial<PlayerState> | null
  actions: string[]
}

function createStore(initial: Partial<PlayerState> | null): FakeStore {
  return { listeners: new Set(), state: initial, actions: [] }
}

function bridgeFor(store: FakeStore, onStatus?: (s: SmtcStatus) => void): MediaSessionBridge {
  const fake = {
    subscribe: (fn: () => void) => { store.listeners.add(fn); return () => store.listeners.delete(fn) },
    getSnapshot: () => ({ state: store.state as PlayerState }),
    play: async () => { store.actions.push('play') },
    pause: async () => { store.actions.push('pause') },
    stop: async () => { store.actions.push('stop') },
    prev: async () => { store.actions.push('prev') },
    next: async () => { store.actions.push('next') },
    seek: async (s: number) => { store.actions.push(`seek:${s}`) },
    seekBy: async (d: number) => { store.actions.push(`seekBy:${d}`) },
  }
  return new MediaSessionBridge(fake as never, onStatus)
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const STATE_PLAYING: Partial<PlayerState> = {
  status: 'playing',
  progress: 30,
  duration: 240,
  current: {
    id: 'wy_1',
    name: '晴天',
    singer: '周杰伦',
    source: 'wy',
    interval: '04:29',
    meta: { songId: 186016, albumName: '叶惠美', picUrl: 'https://p1.music.126.net/cover.jpg?param=300y300' },
  },
}

describe('封面尺寸派生', () => {
  it('识别各平台的尺寸参数并生成小图', () => {
    expect(resizeCoverUrl('https://p1.music.126.net/a.jpg?param=300y300', 96)).toBe('https://p1.music.126.net/a.jpg?param=96y96')
    expect(resizeCoverUrl('https://y.gtimg.cn/music/photo_new/T002R300x300M000abc.jpg', 96)).toBe('https://y.gtimg.cn/music/photo_new/T002R96x96M000abc.jpg')
    expect(resizeCoverUrl('https://img2.kuwo.cn/star/albumcover/500/1.jpg', 96)).toBe('https://img2.kuwo.cn/star/albumcover/96/1.jpg')
    expect(resizeCoverUrl('https://d.musicapp.migu.cn/x.jpg?size=300', 96)).toBe('https://d.musicapp.migu.cn/x.jpg?size=96')
  })

  it('识别不出尺寸参数时返回 null（保留原图，不乱改 URL）', () => {
    expect(resizeCoverUrl('https://example.com/cover.jpg', 96)).toBeNull()
    expect(resizeCoverUrl('', 96)).toBeNull()
  })

  it('coverArtwork：小图在前、原图兜底，且每项都带 sizes', () => {
    const art = coverArtwork('https://p1.music.126.net/a.jpg?param=300y300')
    expect(art.length).toBe(2)
    expect(art[0]?.sizes).toBe('96x96')
    expect(art[1]?.sizes).toBe('512x512')
    expect(coverArtwork(null).length).toBe(0)
  })
})

describe('MediaSessionBridge', () => {
  it('推送标题/歌手/专辑与封面，并声明 playing', () => {
    const session = createFakeSession()
    installGlobals(session)
    const store = createStore(STATE_PLAYING)
    const bridge = bridgeFor(store)
    bridge.start()

    const meta = session.metadata as Record<string, unknown>
    expect(meta.title).toBe('晴天')
    expect(meta.artist).toBe('周杰伦')
    expect(meta.album).toBe('叶惠美')
    const artwork = meta.artwork as Array<Record<string, string>>
    expect(artwork.length).toBe(2)
    expect(artwork[0]?.src).toContain('param=96y96')
    expect(session.playbackState).toBe('playing')
    expect(bridge.diagnostics().artworkPushed).toBe(true)
    // 8 个动作全部注册（系统面板 + 硬件媒体键）
    expect(session.handlers.size).toBe(8)
    bridge.dispose()
  })

  it('没有曲目时也写 metadata（标题回落成 LX Music，避免系统面板继续显示会话名）', () => {
    const session = createFakeSession()
    installGlobals(session)
    const store = createStore({ status: 'stoped', progress: 0, duration: 0, current: null })
    const bridge = bridgeFor(store)
    bridge.start()
    const meta = session.metadata as Record<string, unknown>
    expect(meta.title).toBe('LX Music')
    expect(meta.artist).toBe('未在播放')
    expect(session.playbackState).toBe('none')
    bridge.dispose()
  })

  it('duration 非法时绝不调用 setPositionState（该调用写坏值会抛错并清空 metadata）', () => {
    const session = createFakeSession()
    installGlobals(session)
    const store = createStore({ ...STATE_PLAYING, duration: 0 })
    const bridge = bridgeFor(store)
    bridge.start()
    expect(session.calls.some((c) => c.method === 'setPositionState')).toBe(false)
    // 改成合法时长后（且超过 1s 节流窗口）才推
    store.state = { ...STATE_PLAYING, duration: 240, progress: 10 }
    ;(bridge as unknown as { lastPositionAt: number }).lastPositionAt = 0
    bridge.sync()
    const pos = session.calls.filter((c) => c.method === 'setPositionState')
    expect(pos.length).toBe(1)
    expect((pos[0]?.args[0] as Record<string, number>).duration).toBe(240)
    bridge.dispose()
  })

  it('position 超过 duration 时不推送（浏览器要求 0 ≤ position ≤ duration）', () => {
    const session = createFakeSession()
    installGlobals(session)
    const store = createStore({ ...STATE_PLAYING, duration: 100, progress: 500 })
    const bridge = bridgeFor(store)
    ;(bridge as unknown as { lastPositionAt: number }).lastPositionAt = 0
    bridge.start()
    expect(session.calls.some((c) => c.method === 'setPositionState')).toBe(false)
    bridge.dispose()
  })

  it('setActionHandler 抛错时跳过该动作，其余动作仍注册', () => {
    const session = createFakeSession()
    session.throwOn.add('handler:seekto')
    installGlobals(session)
    const store = createStore(STATE_PLAYING)
    const bridge = bridgeFor(store)
    bridge.start()
    expect(session.handlers.has('seekto')).toBe(false)
    expect(session.handlers.has('nexttrack')).toBe(true)
    expect(bridge.diagnostics().note).toContain('seekto')
    bridge.dispose()
  })

  it('系统面板按钮接回 store（play/pause/next/prev/seekto/seekBy）', () => {
    const session = createFakeSession()
    installGlobals(session)
    const store = createStore(STATE_PLAYING)
    const bridge = bridgeFor(store)
    bridge.start()
    session.handlers.get('play')?.({})
    session.handlers.get('pause')?.({})
    session.handlers.get('nexttrack')?.({})
    session.handlers.get('previoustrack')?.({})
    session.handlers.get('seekto')?.({ seekTime: 12 })
    session.handlers.get('seekforward')?.({ seekOffset: 15 })
    session.handlers.get('seekbackward')?.({})
    session.handlers.get('stop')?.({})
    expect(store.actions).toEqual(['play', 'pause', 'next', 'prev', 'seek:12', 'seekBy:15', 'seekBy:-10', 'stop'])
    bridge.dispose()
  })

  it('状态变化只重推变化部分（metadata 同曲不重建）', () => {
    const session = createFakeSession()
    installGlobals(session)
    const store = createStore(STATE_PLAYING)
    const bridge = bridgeFor(store)
    bridge.start()
    const metaWrites = session.calls.filter((c) => c.method === 'metadata').length
    store.state = { ...STATE_PLAYING, status: 'paused' }
    bridge.sync()
    expect(session.calls.filter((c) => c.method === 'metadata').length).toBe(metaWrites)
    expect(session.playbackState).toBe('paused')
    bridge.dispose()
  })

  it('onStatus 回写不会与 sync 形成无限递归', () => {
    const session = createFakeSession()
    installGlobals(session)
    const store = createStore(STATE_PLAYING)
    let statusCalls = 0
    // 模拟 store.patch：回调里再通知所有订阅者（桥也订阅了）
    const bridge = bridgeFor(store, () => {
      statusCalls++
      for (const fn of store.listeners) fn()
    })
    bridge.start()
    expect(statusCalls).toBe(1)
    store.state = { ...STATE_PLAYING, status: 'paused' }
    bridge.sync()
    expect(statusCalls).toBe(2)
    bridge.dispose()
  })

  it('内核没有 navigator.mediaSession 时整体降级为空操作', () => {
    installGlobals(null)
    const store = createStore(STATE_PLAYING)
    const bridge = bridgeFor(store)
    bridge.start()
    const diag = bridge.diagnostics()
    expect(diag.supported).toBe(false)
    expect(String(diag.note)).toContain('mediaSession')
    // 不能抛错、也不能改 store
    bridge.sync()
    bridge.dispose()
    expect(store.actions.length).toBe(0)
  })

  it('dispose 撤销动作处理器并清空 metadata', () => {
    const session = createFakeSession()
    installGlobals(session)
    const store = createStore(STATE_PLAYING)
    const bridge = bridgeFor(store)
    bridge.start()
    bridge.dispose()
    expect(session.metadata).toBeNull()
    expect(session.playbackState).toBe('none')
    const removed = session.calls.filter((c) => c.method === 'setActionHandler' && c.args[1] === null)
    expect(removed.length).toBe(8)
  })

  it('dispose 后同一个实例可以重新 start（媒体键与 metadata 都要回来）', () => {
    const session = createFakeSession()
    installGlobals(session)
    const store = createStore(STATE_PLAYING)
    const bridge = bridgeFor(store)
    bridge.start()
    bridge.dispose()
    const before = session.calls.length
    bridge.start()
    // 重新注册 8 个动作处理器（不重置 handlersBound 的话这里一个都不会注册）
    const reregistered = session.calls.slice(before).filter((c) => c.method === 'setActionHandler' && c.args[1] !== null)
    expect(reregistered.length).toBe(8)
    // metadata 也要重新写入（否则系统面板回落到页面标题 = 会话名）
    expect((session.metadata as Record<string, unknown>).title).toBe('晴天')
    expect(session.playbackState).toBe('playing')
    bridge.dispose()
  })
})
