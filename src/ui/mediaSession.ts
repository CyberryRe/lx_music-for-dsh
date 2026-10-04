// 系统媒体控件（Windows SMTC / macOS Now Playing / 硬件媒体键）桥。
//
// 为什么需要它：DSH 的 Web GUI 跑在 Chromium 里，页面标题由 DSH 设成
// `<会话名> — DeepSeek Harness`（见 dsh-client-ui-layout）。插件播放音乐用的是裸
// `new Audio()`，**从未设置过 MediaSession 元数据** → 系统媒体面板拿不到歌名，只能回落到
// 页面标题，于是用户看到的是"会话名"。
//
// 这里把权威播放状态（host 的 PlayerState）翻译成 Chromium 的 MediaSession 调用：
//   - `metadata`：标题/歌手/专辑/**封面**（多尺寸，系统按需选）
//   - `playbackState`：playing / paused / none
//   - `setPositionState`：进度条
//   - `setActionHandler`：系统面板与**硬件媒体键**的播放/暂停/上一首/下一首/快进快退接回 store
//
// 三条硬约束（都是踩过的坑）：
//   1. `navigator.mediaSession` 可能不存在（非 Chromium 内核）→ 整桥静默降级为空操作；
//   2. `setActionHandler` 对不支持的动作会**抛错** → 逐个 try/catch，一个动作失败不影响其它；
//   3. `setPositionState` 在 duration 为 0/NaN/Infinity 或 position > duration 时**抛错**，
//      所以先做数值校验再调用（播放器刚切歌时 duration 常是 0）。
//
// 另外：没有曲目时也要写一份中性 metadata（"LX Music / 未在播放"）。否则系统面板会继续
// 用页面标题兜底，等于"插件没在放歌时又会显示会话名"。

import type { SmtcStatus } from '../shared/types'
import type { LxStore } from './store'

/** 进度推送节流（毫秒）：store 每次 timeupdate 都 patch，没必要每帧都推给系统。 */
const POSITION_THROTTLE_MS = 1000

/**
 * 由封面 URL 派生不同尺寸的候选项。
 *
 * 各平台把尺寸写在 URL 里（网易 `?param=300y300`、QQ `R300x300M000`、酷我 `/star/albumcover/300`、
 * 咪咕 `size=300`）。系统面板通常只要一张小图，声明 `sizes` + 提供小图能避免为了缩略图
 * 下载一张 1000px 的大图（也绕开部分 CDN 的大图限速）。
 * 返回的第一项是系统优先选择的小图；识别不出尺寸参数时只返回原图。
 */
export function coverArtwork(picUrl: string | null | undefined): Array<{ src: string; sizes: string }> {
  const url = (picUrl ?? '').trim()
  if (!url) return []
  const small = resizeCoverUrl(url, 96)
  const large = resizeCoverUrl(url, 512) ?? url
  const out: Array<{ src: string; sizes: string }> = []
  if (small && small !== large) out.push({ src: small, sizes: '96x96' })
  out.push({ src: large, sizes: '512x512' })
  return out
}

/** 把 URL 里的尺寸参数换成 `size`；识别不出则返回 null（调用方保留原 URL）。 */
export function resizeCoverUrl(url: string, size: number): string | null {
  if (!url) return null
  const rules: Array<[RegExp, string]> = [
    [/([?&]param=)\d+y\d+/, `$1${size}y${size}`],
    [/(R)\d+x\d+(M000)/, `$1${size}x${size}$2`],
    [/(\/star\/albumcover\/)\d+/, `$1${size}`],
    [/([?&]size=)\d+/, `$1${size}`],
    [/(pictype=)\d+/, `$1${size}`],
  ]
  for (const [re, replacement] of rules) {
    if (re.test(url)) return url.replace(re, replacement)
  }
  return null
}

export class MediaSessionBridge {
  private readonly store: LxStore
  private readonly onStatus?: (status: SmtcStatus) => void
  private unsubscribe: (() => void) | null = null
  private handlersBound = false
  private readonly boundActions: MediaSessionAction[] = []
  private lastMetaKey = ''
  private lastStatusKey = ''
  private lastStatusSignature = ''
  private lastPositionAt = 0
  private note: string | undefined
  private status: SmtcStatus = { supported: false, title: '', artist: '', artwork: '', artworkPushed: false, playbackState: 'none' }

  constructor(store: LxStore, onStatus?: (status: SmtcStatus) => void) {
    this.store = store
    this.onStatus = onStatus
  }

  private get session(): MediaSession | null {
    if (typeof navigator === 'undefined') return null
    return (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession ?? null
  }

  start(): void {
    if (this.unsubscribe) return
    const session = this.session
    if (!session) {
      this.note = '当前内核没有 navigator.mediaSession，系统媒体控件只能显示页面标题'
      this.pushStatus({ supported: false })
      return
    }
    this.status.supported = true
    this.bindHandlers(session)
    this.unsubscribe = this.store.subscribe(() => this.sync())
    this.sync()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    // 允许同一个实例 dispose → start 复用：不重置这些标记的话，重启后既不会重新注册
    // 动作处理器（媒体键全失效），也会因为 metaKey 未变而不写 metadata
    // （于是系统面板又回落到页面标题 = 会话名，正是本模块要修的问题）。
    this.handlersBound = false
    this.lastMetaKey = ''
    this.lastStatusKey = ''
    this.lastStatusSignature = ''
    this.lastPositionAt = 0
    const session = this.session
    if (!session) return
    // 撤销动作处理器 + 清空 metadata：插件卸载后系统面板不该还留着我们的按钮和歌名
    for (const action of this.boundActions) {
      try {
        session.setActionHandler(action, null)
      } catch {
        // 忽略
      }
    }
    this.boundActions.length = 0
    try {
      session.metadata = null
      session.playbackState = 'none'
    } catch {
      // 内核不支持时忽略
    }
  }

  /** 最近一次推送的状态（UI 自检展示用）。 */
  diagnostics(): SmtcStatus {
    return { ...this.status, ...(this.note ? { note: this.note } : {}) }
  }

  /** 系统面板 → store：动作处理表。 */
  private bindHandlers(session: MediaSession): void {
    if (this.handlersBound) return
    this.handlersBound = true
    const store = this.store
    const handlers: Array<[MediaSessionAction, (details: MediaSessionActionDetails) => void]> = [
      ['play', () => void store.play()],
      ['pause', () => void store.pause()],
      ['stop', () => void store.stop()],
      ['previoustrack', () => void store.prev()],
      ['nexttrack', () => void store.next()],
      ['seekbackward', (d) => void store.seekBy(-(typeof d.seekOffset === 'number' ? d.seekOffset : 10))],
      ['seekforward', (d) => void store.seekBy(typeof d.seekOffset === 'number' ? d.seekOffset : 10)],
      ['seekto', (d) => {
        if (typeof d.seekTime === 'number') void store.seek(d.seekTime)
      }],
    ]
    const failed: string[] = []
    for (const [action, handler] of handlers) {
      try {
        session.setActionHandler(action, handler)
        this.boundActions.push(action)
      } catch {
        failed.push(action)
      }
    }
    if (failed.length > 0) this.note = `系统面板不支持的动作已跳过：${failed.join(', ')}`
  }

  /** 把当前状态同步到系统媒体面板（幂等：只有变化的部分才写）。 */
  sync(): void {
    const session = this.session
    if (!session) return
    const state = this.store.getSnapshot().state
    const current = state?.current ?? null

    // `||`（不是 `??`）：空字符串同样会让系统面板回落到页面标题，必须也换掉
    const title = current?.name || 'LX Music'
    const artist = current?.singer || '未在播放'
    const album = current?.meta?.albumName || ''
    const artwork = (current?.meta?.picUrl ?? '').trim()
    const metaKey = `${title}|${artist}|${album}|${artwork}`
    if (metaKey !== this.lastMetaKey) {
      const images = coverArtwork(artwork)
      try {
        session.metadata = new MediaMetadata({
          title,
          artist,
          album,
          ...(images.length > 0 ? { artwork: images } : {}),
        })
        // 只有真的写成功才记住 key：写失败时下一轮还会重试（自检状态里会带 note）
        this.lastMetaKey = metaKey
        this.status.title = title
        this.status.artist = artist
        this.status.artwork = artwork
        this.status.artworkPushed = images.length > 0
      } catch (err) {
        // 失败也要记 key，否则每个 store 事件都会重试一次并刷屏；状态里如实标注失败
        this.lastMetaKey = metaKey
        this.note = `MediaMetadata 写入失败：${err instanceof Error ? err.message : String(err)}`
        this.status.title = title
        this.status.artist = artist
        this.status.artwork = artwork
        this.status.artworkPushed = false
      }
    }

    const playbackState: MediaSessionPlaybackState = state?.status === 'playing' ? 'playing' : current ? 'paused' : 'none'
    const statusKey = `${playbackState}|${state?.status ?? ''}`
    if (statusKey !== this.lastStatusKey) {
      this.lastStatusKey = statusKey
      try {
        session.playbackState = playbackState
        this.status.playbackState = playbackState
      } catch {
        // 内核不支持 playbackState 时忽略
      }
    }

    // 进度：duration 必须是有限正数，position 不能超过 duration（否则 setPositionState 抛错）
    const now = Date.now()
    const duration = state?.duration ?? 0
    const position = state?.progress ?? 0
    if (now - this.lastPositionAt >= POSITION_THROTTLE_MS
      && Number.isFinite(duration) && duration > 0
      && Number.isFinite(position) && position >= 0 && position <= duration) {
      this.lastPositionAt = now
      try {
        session.setPositionState({ duration, position, playbackRate: 1 })
      } catch {
        // 个别内核在 duration 极小时仍会抛错：忽略，下一轮再试
      }
    }

    this.pushStatus({})
  }

  /**
   * 把自检状态推给 UI。
   *
   * ⚠️ 必须**去重**：`onStatus` 会写回 store，而 store 的 patch 会通知订阅者，订阅者又是
   * 本桥的 `sync()` —— 不去重就是 `sync → patch → sync` 的无限递归。
   */
  private pushStatus(patch: Partial<SmtcStatus>): void {
    this.status = { ...this.status, ...patch }
    const next: SmtcStatus = { ...this.status, ...(this.note ? { note: this.note } : {}) }
    const signature = `${next.supported}|${next.title}|${next.artist}|${next.artwork}|${next.artworkPushed}|${next.playbackState}|${next.note ?? ''}`
    if (signature === this.lastStatusSignature) return
    this.lastStatusSignature = signature
    if (!this.onStatus) return
    try {
      this.onStatus(next)
    } catch {
      // UI 状态回调失败不能影响播放
    }
  }
}
