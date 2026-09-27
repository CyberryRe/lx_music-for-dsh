// 播放行为录制器（捕获层）：把 PlaybackService 的状态变化折算成画像事件。
//
// 职责边界：
//   - 只有**终态**才落库：曲目结束、被切走、被移除。`reportProgress` 那种 1 秒一次的高频回调
//     只更新内存里的最大播放时长（写入频率 = O(点歌次数)，这是成本模型的地基）。
//   - 规则都在 events.ts（纯函数），这里只负责"会话生命周期 + 何时结算 + 落盘"。
//   - **绝不阻塞播放路径**：所有写操作都 fire-and-forget 并吞掉异常（画像坏了不能影响放歌）。

import type { MusicInfo, PlaybackStatus } from '../shared/types'
import { normalizeArtist, secondsFromInterval, trackKey as makeTrackKey } from './normalize'
import {
  intentDeltas,
  settlePlaySession,
  type EntityDelta,
  type TasteEventMode,
  type TasteEventOrigin,
} from './events'
import { currentPlayContext } from './origin'
import type { TasteStore } from './store'
import type { StoredMusicInfo } from './schema'

/** 来源/情境三件套（与 origin.ts 的 PlayContext 结构一致，避免循环依赖所以这里再声明一次）。 */
export interface PlayContextLike {
  origin: TasteEventOrigin
  mode?: TasteEventMode
  context?: string
}

/** 一次播放会话（内存态）。 */
export interface ActiveSession {
  /** 归一化后的曲目 key（`曲名|艺人`）。 */
  trackKey: string
  artistKey: string
  title: string
  artist: string
  source: string
  quality?: string
  origin: TasteEventOrigin
  mode: TasteEventMode
  context?: string
  startedTs: number
  /** 已播放到的最远位置（秒）：用最大进度而非当前进度，避免拖进度条把"秒切"洗白。 */
  maxProgressSec: number
  durationSec: number
  /** 同一首在 single 模式下重复开始的次数（>0 表示发生过重播）。 */
  repeats: number
  /** 原始 MusicInfo：结算时要拿它写 Tier-1 可播放载荷。 */
  music: MusicInfo
}

export interface RecorderOptions {
  store: TasteStore
  now?: () => number
  /** implicit 半衰期（来自画像配置）。 */
  halfLifeDays?: number
  /** 当前探索比例（写进探索统计，供自适应参考）。 */
  exploreRatio?: number
  /** 日志出口（由宿主决定去 logger 还是 console）。 */
  onWarn?: (message: string, err?: unknown) => void
}

/**
 * 把播放服务的行为录制成画像事件。
 *
 * 所有写操作都通过 `void this.run(...)` 异步进行：录制失败只记日志，不改变播放结果。
 */
export class TasteRecorder {
  private readonly store: TasteStore
  private readonly now: () => number
  private readonly onWarn: (message: string, err?: unknown) => void
  private session: ActiveSession | null = null

  /** implicit 半衰期（天），由 index.ts 从画像配置注入。 */
  halfLifeDays: number
  /** 探索比例，由 index.ts 从画像配置注入（自适应探索率在 P1 调它）。 */
  exploreRatio: number

  constructor(options: RecorderOptions) {
    this.store = options.store
    this.now = options.now ?? Date.now
    this.onWarn = options.onWarn ?? ((): void => {})
    this.halfLifeDays = options.halfLifeDays ?? 90
    this.exploreRatio = options.exploreRatio ?? 0.2
  }

  /** 当前会话（测试与诊断用）。 */
  activeSession(): ActiveSession | null {
    return this.session
  }

  /**
   * 曲目开始播放（用户点按 / AI 工具 / 自动续播都走这里）。
   *
   * 同一首再次开始 = 重播（不结算、只累加 repeats）；切到别的曲目 = 先结算上一首再开新会话。
   */
  notePlay(music: MusicInfo | null, options: { quality?: string; context?: PlayContextLike } = {}): void {
    if (!music) {
      this.settle('stopped')
      return
    }
    const ctx: PlayContextLike = options.context ?? currentPlayContext()
    const key = makeTrackKey(music.name, music.singer)
    const durationSec = secondsFromInterval(music.interval) ?? 0

    if (this.session && this.session.trackKey === key) {
      // 重播同一首：不结算，但要记住这次是重播触发的
      this.session.repeats += 1
      this.session.maxProgressSec = 0
      if (durationSec > 0) this.session.durationSec = durationSec
      this.session.music = music
      return
    }

    // 切歌：先把上一首结算掉（按已播比例判定是"听完"还是"切走"）
    this.settle('switch')

    const ts = this.now()
    this.session = {
      trackKey: key,
      artistKey: normalizeArtist(music.singer),
      title: music.name,
      artist: music.singer,
      source: music.source,
      ...(options.quality ? { quality: options.quality } : {}),
      origin: ctx.origin,
      mode: ctx.mode ?? 'replay',
      ...(ctx.context ? { context: ctx.context } : {}),
      startedTs: ts,
      maxProgressSec: 0,
      durationSec,
      repeats: 0,
      music,
    }

    // 记下"这首歌在某平台可播"：Tier-1 直取的可播放载荷。此时还没确认播放成功 → seen
    void this.run(() =>
      this.store.upsertTrackRef({
        trackKey: key,
        title: music.name,
        artist: music.singer,
        music: music as StoredMusicInfo,
        played: false,
        ...(music.meta?.albumName ? { album: music.meta.albumName } : {}),
        ...(durationSec > 0 ? { durationSec } : {}),
        now: ts,
      }),
    )
  }

  /** 客户端上报进度（高频）：只更新内存，不落库。 */
  noteProgress(progress: number, duration: number, status: PlaybackStatus): void {
    const session = this.session
    if (!session) return
    // 播放失败（直链解析/解码出错）不是偏好信号：直接结束会话，避免下次切歌把它误记成"切走"
    if (status === 'error') {
      this.session = null
      return
    }
    if (typeof duration === 'number' && duration > 0) session.durationSec = duration
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      session.maxProgressSec = Math.max(session.maxProgressSec, progress)
    }
    if (this.isFinished()) this.settle('finished')
  }

  /** 顺序播放到列表末尾：视作当前曲目正常放完。 */
  noteFinished(): void {
    const session = this.session
    if (session) session.maxProgressSec = Math.max(session.maxProgressSec, session.durationSec)
    this.settle('finished')
  }

  /** 加入播放列表（意图信号：排队 +0.2；用户明确点歌额外 +1.0）。 */
  noteIntent(musics: readonly MusicInfo[], origin?: TasteEventOrigin): void {
    if (musics.length === 0) return
    const ctx = currentPlayContext()
    const ctxOrigin = origin ?? ctx.origin
    const ts = this.now()
    const deltas: EntityDelta[] = []
    for (const music of musics) {
      deltas.push(
        ...intentDeltas({
          trackKey: makeTrackKey(music.name, music.singer),
          artistKey: normalizeArtist(music.singer),
          origin: ctxOrigin,
          ...(music.source ? { source: music.source } : {}),
          ts,
        }),
      )
    }
    const first = musics[0]
    void this.run(async () => {
      await this.store.appendEvent({
        kind: 'play',
        origin: ctxOrigin,
        mode: ctx.mode ?? 'replay',
        ts,
        ...(first ? { trackKey: makeTrackKey(first.name, first.singer), title: first.name, artist: first.singer, source: first.source } : {}),
        deltas,
      })
      await this.store.applyDeltas(deltas, { now: ts, halfLifeDays: this.halfLifeDays })
    })
  }

  /** 曲目被移除/列表被清空：只有真的听过一段才结算（单纯清理列表不该算作"不喜欢"）。 */
  noteRemoved(): void {
    if (!this.session) return
    if (this.ratio() >= 0.3) this.settle('switch')
    else this.session = null
  }

  /** 插件卸载/宿主退出：把当前会话按已播比例结算掉（不丢证据）。 */
  flush(): void {
    if (this.session) this.settle('switch')
  }

  // -------------------------------------------------------------------------

  /** 结算时必须传 session：settle() 会先把 this.session 置空，读 this.session 会拿到 0。 */
  private ratioOf(session: ActiveSession | null): number {
    if (!session) return 0
    if (session.durationSec > 0) return Math.min(1, session.maxProgressSec / session.durationSec)
    // 没有时长信息时粗判：有过进度就算部分播放
    return session.maxProgressSec > 0 ? 0.5 : 0
  }

  private ratio(): number {
    return this.ratioOf(this.session)
  }

  private isFinished(): boolean {
    const session = this.session
    if (!session || session.durationSec <= 0) return false
    return session.maxProgressSec >= session.durationSec - 1
  }

  /**
   * 结算当前会话：生成信号 → 写事件 → 更新聚合 → 更新 seen/played 与探索统计。
   *
   * 关键：**只有真的播放过（比例 ≥ 0.3）才把曲目标成 played**；探索只确认身份的曲目保持 seen，
   * 否则"没听过的歌"池子会枯竭（设计文档 §18.2 坑 1）。
   */
  private settle(reason: 'switch' | 'finished' | 'stopped'): void {
    const session = this.session
    if (!session) return
    this.session = null
    const ts = this.now()
    // 注意：必须用捕获的 session 算比例（this.session 已经置空，见 ratioOf 的注释）
    const played = reason === 'finished' ? Math.max(this.ratioOf(session), 1) : this.ratioOf(session)
    const deltas = settlePlaySession({
      title: session.title,
      artist: session.artist,
      trackKey: session.trackKey,
      artistKey: session.artistKey,
      source: session.source,
      origin: session.origin,
      mode: session.mode,
      playedRatio: played,
      replayed: session.repeats > 0,
      ...(session.context ? { context: session.context } : {}),
      ts,
    })

    const listened = played >= 0.3
    void this.run(async () => {
      await this.store.appendEvent({
        kind: 'settle',
        origin: session.origin,
        mode: session.mode,
        ts,
        trackKey: session.trackKey,
        artistKey: session.artistKey,
        title: session.title,
        artist: session.artist,
        source: session.source,
        ...(session.quality ? { quality: session.quality } : {}),
        playedRatio: Number(played.toFixed(4)),
        replayed: session.repeats > 0,
        ...(session.context ? { context: session.context } : {}),
        deltas,
      })
      if (deltas.length > 0) {
        await this.store.applyDeltas(deltas, { now: ts, halfLifeDays: this.halfLifeDays })
      }
      await this.store.upsertTrackRef({
        trackKey: session.trackKey,
        title: session.title,
        artist: session.artist,
        music: session.music as StoredMusicInfo,
        played: listened,
        explored: session.mode === 'explore',
        resolved: listened,
        now: ts,
      })
      await this.store.bumpExploreStats(session.mode, listened ? 'play' : 'skip', this.exploreRatio)
    })
  }

  /** fire-and-forget：录制失败只记日志，绝不冒泡到播放路径。 */
  private async run(task: () => Promise<void>): Promise<void> {
    try {
      await task()
    } catch (err) {
      this.onWarn('[lx-music-for-dsh] 画像录制失败（不影响播放）', err)
    }
  }
}
