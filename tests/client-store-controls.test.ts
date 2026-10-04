// client store 的播放控制、音量与歌词状态单测（1.3.0 新增能力）。
//
// 覆盖的都是"看起来能跑、但边界一碰就错"的地方：
//   - 系统媒体键/面板发来的 play/pause 不能走 toggle（本来在播时会被反向切停）；
//   - 音量拖动期间不能刷 RPC（previewVolume 只动本地），提交时才同步 host 并解除静音；
//   - 歌词有"代数"防竞态：换歌后迟到的旧歌词必须被丢弃；
//   - 拿不到歌词是正常状态（空文档 + note），不能变成 error。

import { afterEach, describe, expect, it, vi } from './mini'
import { LxStore, type LxRemote } from '../src/ui/store'
import { DEFAULT_SETTINGS, type LyricDoc, type MusicInfo, type PlayerState, type Quality } from '../src/shared/types'

class FakeAudio {
  src = ''
  volume = 1
  paused = true
  currentTime = 0
  duration = 0
  preload = ''
  addEventListener(): void {}
  removeEventListener(): void {}
  async play(): Promise<void> { this.paused = false }
  pause(): void { this.paused = true }
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

function playerState(current: MusicInfo | null, status: PlayerState['status'], version: number, patch: Partial<PlayerState> = {}): PlayerState {
  return {
    playlist: current ? [current] : [],
    currentIndex: current ? 0 : -1,
    status,
    progress: 0,
    duration: 180,
    current,
    quality: '320k',
    volume: 1,
    mute: false,
    playMode: 'list',
    version,
    ...patch,
  }
}

function lyricDoc(text: string, source = 'sdk'): LyricDoc {
  return {
    source: source as LyricDoc['source'],
    format: 'lrc',
    lines: [{ time: 1, text, duration: 4 }],
    offset: 0,
    hasTranslation: false,
    hasWordTiming: false,
    plain: false,
    duration: 5,
  }
}

interface Harness {
  store: LxStore
  audio: FakeAudio
  calls: string[]
  apply: (s: PlayerState) => void
  /** 让下一次 getLyric 挂起，返回手动结算的句柄。 */
  deferLyric: () => { resolve: (doc: LyricDoc) => void; reject: (err: Error) => void }
  lyricCalls: MusicInfo[]
}

function harness(overrides: Partial<LxRemote> = {}): Harness {
  const audio = new FakeAudio()
  vi.stubGlobal('Audio', function FakeAudioCtor() { return audio })
  const calls: string[] = []
  const current: PlayerState = playerState(music('a', '第一首'), 'paused', 1)
  const pending: Array<{ resolve: (doc: LyricDoc) => void; reject: (err: Error) => void }> = []
  const lyricCalls: MusicInfo[] = []

  const remote = {
    getState: async () => current,
    getSettings: async () => DEFAULT_SETTINGS,
    listSources: async () => [],
    resolveUrl: async () => ({ url: 'https://example.com/x.mp3', type: '320k' as Quality }),
    reportProgress: async () => undefined,
    toggle: async () => {
      calls.push('toggle')
      current.status = current.status === 'playing' ? 'paused' : 'playing'
      return current
    },
    setVolume: async (v: number) => {
      calls.push(`setVolume:${v}`)
      current.volume = v
      return current
    },
    setMute: async (m: boolean) => {
      calls.push(`setMute:${m}`)
      current.mute = m
      return current
    },
    prev: async () => { calls.push('prev'); return current },
    next: async () => { calls.push('next'); return current },
    seek: async (s: number) => { calls.push(`seek:${s}`) },
    getLyric: (req: { music: MusicInfo }) => {
      lyricCalls.push(req.music)
      return new Promise<LyricDoc>((resolve, reject) => pending.push({ resolve, reject }))
    },
    getTasteProfile: async () => ({ enabled: false, onboarded: true, snoozed: false, summary: '', artists: [], tracks: [], sampleSize: 0, config: null }),
    getTasteEvents: async () => [],
    ...overrides,
  } as unknown as LxRemote

  const store = new LxStore(remote)
  ;(store as unknown as { audio: FakeAudio }).audio = audio
  return {
    store,
    audio,
    calls,
    // 假 host 的权威状态必须跟着 apply 走：remote.toggle/setVolume 返回的是**它**，
    // 不同步就会出现"测试以为静音了，host 返回的却还是旧状态"的假失败。
    apply: (s) => {
      Object.assign(current, s)
      ;(store as unknown as { applyState(v: PlayerState): void }).applyState(s)
    },
    deferLyric: () => {
      const entry = pending.shift()
      if (!entry) throw new Error('没有挂起的 getLyric 调用')
      return entry
    },
    lyricCalls,
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('播放控制：媒体键语义', () => {
  it('play() 在已播放时不动、暂停时才切换', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'paused', 1))
    await h.store.play()
    expect(h.calls).toEqual(['toggle'])
    // remote.toggle 已把状态翻成 playing 并由 applyState 落地
    await h.store.play()
    expect(h.calls).toEqual(['toggle'])
  })

  it('pause() 在暂停时不动作、播放时才切换', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    await h.store.pause()
    expect(h.calls).toEqual(['toggle'])
    await h.store.pause()
    expect(h.calls).toEqual(['toggle'])
  })

  it('stop() = 暂停 + 回到开头', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    await h.store.stop()
    expect(h.calls).toEqual(['toggle', 'seek:0'])
    expect(h.audio.currentTime).toBe(0)
  })

  it('seekBy() 相对跳转并夹在 [0, duration] 内', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    h.audio.currentTime = 100
    h.audio.duration = 180
    await h.store.seekBy(30)
    expect(h.audio.currentTime).toBe(130)
    await h.store.seekBy(500)
    expect(h.audio.currentTime).toBe(180)
    await h.store.seekBy(-1000)
    expect(h.audio.currentTime).toBe(0)
  })
})

describe('音量', () => {
  it('拖动中的预览只改本地（不刷 RPC）', () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'paused', 1))
    h.store.previewVolume(0.35)
    expect(h.audio.volume).toBeCloseTo(0.35, 3)
    expect(h.store.getSnapshot().state?.volume).toBeCloseTo(0.35, 3)
    expect(h.calls).toEqual([])
  })

  it('静音状态下拖动即本地解除静音（先让人听见）', () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'paused', 1, { mute: true, volume: 0.8 }))
    h.store.previewVolume(0.5)
    expect(h.store.getSnapshot().state?.mute).toBe(false)
    expect(h.audio.volume).toBeCloseTo(0.5, 3)
  })

  it('提交音量会同步 host，并在静音时顺带解除静音', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'paused', 1, { mute: true, volume: 0.8 }))
    await h.store.setVolume(0.6)
    expect(h.calls).toEqual(['setVolume:0.6', 'setMute:false'])
    expect(h.audio.volume).toBeCloseTo(0.6, 3)
  })

  it('setMute(true) 立刻静音 audio，并在 host 返回后保持一致', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1, { volume: 0.9 }))
    await h.store.setMute(true)
    expect(h.audio.volume).toBe(0)
    expect(h.calls).toEqual(['setMute:true'])
    await h.store.toggleMute()
    expect(h.calls).toEqual(['setMute:true', 'setMute:false'])
    expect(h.audio.volume).toBeCloseTo(0.9, 3)
  })

  it('迟到的音量响应不会把音量倒回旧值（键盘连按会并发）', async () => {
    const resolvers: Array<() => void> = []
    // 可控的 setVolume：把响应压住，由测试决定结算顺序
    const h = harness({
      setVolume: (v: number) => new Promise<PlayerState>((resolve) => {
        resolvers.push(() => resolve({ ...(h.store.getSnapshot().state as PlayerState), volume: v, mute: false }))
      }),
    } as never)
    h.apply(playerState(music('a', '第一首'), 'playing', 1, { volume: 0.5 }))
    const older = h.store.setVolume(0.3)
    const newer = h.store.setVolume(0.7)
    // 后发先至：先结算新请求，再结算旧请求（旧响应必须被代数守卫丢弃）
    resolvers[1]!()
    resolvers[0]!()
    await Promise.all([older, newer])
    expect(h.store.getSnapshot().state?.volume).toBeCloseTo(0.7, 3)
  })
})

describe('歌词状态', () => {
  it('openLyrics() 取词并把文档放进快照', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    h.store.openLyrics()
    expect(h.store.getSnapshot().lyricsOpen).toBe(true)
    expect(h.store.getSnapshot().lyricLoading).toBe(true)
    expect(h.lyricCalls.map((m) => m.id)).toEqual(['a'])
    h.deferLyric().resolve(lyricDoc('第一句'))
    await Promise.resolve()
    const snap = h.store.getSnapshot()
    expect(snap.lyric?.lines[0]?.text).toBe('第一句')
    expect(snap.lyricLoading).toBe(false)
    expect(snap.lyricError).toBeNull()
  })

  it('换歌时自动重取，迟到的旧歌词被丢弃（代数防竞态）', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    h.store.openLyrics()
    const first = h.deferLyric()
    // 还没返回就切歌 → 触发第二次取词
    h.apply(playerState(music('b', '第二首'), 'playing', 2))
    const second = h.deferLyric()
    expect(h.lyricCalls.map((m) => m.id)).toEqual(['a', 'b'])
    // 新歌先返回、旧歌后返回：快照必须是新歌的歌词
    second.resolve(lyricDoc('新歌歌词'))
    await Promise.resolve()
    first.resolve(lyricDoc('旧歌歌词'))
    await Promise.resolve()
    expect(h.store.getSnapshot().lyric?.lines[0]?.text).toBe('新歌歌词')
  })

  it('窗口没打开时不取词（不在后台白打接口）', () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    h.apply(playerState(music('b', '第二首'), 'playing', 2))
    expect(h.lyricCalls.length).toBe(0)
  })

  it('换歌时先清掉上一首的歌词（不能出现"新歌名 + 旧歌词"）', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    h.store.openLyrics()
    h.deferLyric().resolve(lyricDoc('旧歌歌词'))
    await Promise.resolve()
    expect(h.store.getSnapshot().lyric?.lines[0]?.text).toBe('旧歌歌词')
    // 切歌：新请求还在飞，但旧歌词必须立刻消失（代数守卫只挡迟到的响应，挡不住已渲染的文档）
    h.apply(playerState(music('b', '第二首'), 'playing', 2))
    expect(h.store.getSnapshot().lyric).toBeNull()
    expect(h.store.getSnapshot().lyricLoading).toBe(true)
  })

  it('同一首手动刷新不会清空当前歌词（不闪白）', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    h.store.openLyrics()
    h.deferLyric().resolve(lyricDoc('第一句'))
    await Promise.resolve()
    const reload = h.store.reloadLyric()
    expect(h.store.getSnapshot().lyric?.lines[0]?.text).toBe('第一句')
    h.deferLyric().resolve(lyricDoc('刷新后的第一句'))
    await reload
    expect(h.store.getSnapshot().lyric?.lines[0]?.text).toBe('刷新后的第一句')
  })

  it('拿不到歌词：保留空文档 + note，不写 error', async () => {    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    h.store.openLyrics()
    h.deferLyric().resolve({ ...lyricDoc('x'), lines: [], format: 'none', note: '未找到歌词' })
    await Promise.resolve()
    const snap = h.store.getSnapshot()
    expect(snap.lyric?.lines.length).toBe(0)
    expect(snap.lyric?.note).toBe('未找到歌词')
    expect(snap.lyricError).toBeNull()
    expect(snap.lyricLoading).toBe(false)
  })

  it('RPC 失败：写 error 并把 loading 复位', async () => {
    const h = harness()
    h.apply(playerState(music('a', '第一首'), 'playing', 1))
    h.store.openLyrics()
    h.deferLyric().reject(new Error('host 挂了'))
    await Promise.resolve()
    await Promise.resolve()
    const snap = h.store.getSnapshot()
    expect(snap.lyricError).toBe('host 挂了')
    expect(snap.lyricLoading).toBe(false)
  })

  it('没有正在播放的歌时给出明确提示', () => {
    const h = harness()
    h.apply(playerState(null, 'stoped', 1))
    h.store.openLyrics()
    expect(h.store.getSnapshot().lyricError).toBe('没有正在播放的歌曲')
    expect(h.lyricCalls.length).toBe(0)
  })
})

describe('SMTC 自检状态写回', () => {
  it('相同状态不重复通知订阅者（桥与 store 的递归防线）', () => {
    const h = harness()
    let emits = 0
    h.store.subscribe(() => { emits++ })
    const status = { supported: true, title: '歌', artist: '手', artwork: 'u', artworkPushed: true, playbackState: 'playing' }
    h.store.setSmtcStatus(status)
    h.store.setSmtcStatus({ ...status })
    expect(emits).toBe(1)
    h.store.setSmtcStatus({ ...status, playbackState: 'paused' })
    expect(emits).toBe(2)
  })
})
