// 画像门面（TasteFacade）：把 store / recorder / 配置持久化组合成 UI 与 Remote 能用的一个面。
//
// 为什么单独一层：
//   - playback.ts 只该依赖**窄接口**（捕获钩子 + 少量查询），不该知道 storage 与配置怎么落盘；
//   - 客户端的「我的口味」页需要读画像、改配置、看证据、清空/遗忘——这些都在这里，
//     全部是可 headless 测试的纯逻辑，UI 只做渲染。

import type { StorageFace } from '../playback'
import { cleanupLocalData } from '../storage/cleanup'
import type {
  MemoryConfigView,
  MusicInfo,
  PlaybackStatus,
  TasteActionResult,
  TasteActionInput,
  TasteArtistRow,
  TasteEventRow,
  TasteProfileView,
  TasteTrackRow,
} from '../shared/types'
import { normalizeMemoryConfig, type MemoryConfig } from './config'
import type { TasteStore } from './store'
import type { TasteRecorder } from './recorder'
import type { StoredTrack } from './schema'
import { explicitDelta } from './events'
import { normalizeArtist } from './normalize'

export interface TasteFacadeDeps {
  store: TasteStore
  recorder?: TasteRecorder
  storage?: StorageFace
  memory: MemoryConfig
  now?: () => number
  /** 配置变更后的回调（index.ts 用它同步 recorder 的半衰期/探索率）。 */
  onMemoryChange?: (memory: MemoryConfig) => void
  onWarn?: (message: string, err?: unknown) => void
}

/** MemoryConfig → UI 视图（形状一致；显式展开可选字段，避免 exactOptionalPropertyTypes 报错）。 */
function toConfigView(memory: MemoryConfig): MemoryConfigView {
  return {
    enabled: memory.enabled,
    halfLifeDays: memory.halfLifeDays,
    retainDays: memory.retainDays,
    budget: memory.budget,
    semanticProfile: memory.semanticProfile,
    profileCallsPerHour: memory.profileCallsPerHour,
    exploreRatio: memory.exploreRatio,
    ...(memory.onboardedAt ? { onboardedAt: memory.onboardedAt } : {}),
    ...(memory.snoozedUntil ? { snoozedUntil: memory.snoozedUntil } : {}),
    ...(memory.migratedFrom ? { migratedFrom: memory.migratedFrom } : {}),
    ...(memory.experimentalOptInAt ? { experimentalOptInAt: memory.experimentalOptInAt } : {}),
  }
}

/**
 * 画像门面：同时实现**捕获钩子**（转发给 recorder，并按开关实时门控）与 **UI/Remote 读写**。
 *
 * 门控放在这里而不是接线时：用户关掉画像开关后立刻停止录制，不需要重启或重连。
 */
export class TasteFacade {
  private readonly store: TasteStore
  private readonly recorder?: TasteRecorder
  private readonly storage?: StorageFace
  private readonly now: () => number
  private readonly onMemoryChange?: (memory: MemoryConfig) => void
  private readonly onWarn: (message: string, err?: unknown) => void
  private memory: MemoryConfig

  constructor(deps: TasteFacadeDeps) {
    this.store = deps.store
    this.recorder = deps.recorder
    this.storage = deps.storage
    this.memory = deps.memory
    this.now = deps.now ?? Date.now
    this.onMemoryChange = deps.onMemoryChange
    this.onWarn = deps.onWarn ?? ((): void => {})
  }

  // ── 捕获钩子（转发给 recorder；关闭时全部 no-op）─────────────────────────

  activeSession(): unknown {
    return this.memory.enabled ? (this.recorder?.activeSession() ?? null) : null
  }

  notePlay(music: MusicInfo | null, options?: { quality?: string }): void {
    if (this.memory.enabled) this.recorder?.notePlay(music, options)
  }

  noteProgress(progress: number, duration: number, status: PlaybackStatus): void {
    if (this.memory.enabled) this.recorder?.noteProgress(progress, duration, status)
  }

  noteFinished(): void {
    if (this.memory.enabled) this.recorder?.noteFinished()
  }

  noteIntent(musics: readonly MusicInfo[]): void {
    if (this.memory.enabled) this.recorder?.noteIntent(musics)
  }

  noteRemoved(): void {
    if (this.memory.enabled) this.recorder?.noteRemoved()
  }

  /** 卸载时结算（即使开关被关掉也要 flush，避免丢掉关闭前已开始的会话）。 */
  flush(): void {
    this.recorder?.flush()
  }

  currentConfig(): MemoryConfig {
    return this.memory
  }

  /** 画像视图（UI 的「我的口味」页与首启引导都读它）。 */
  profile(req: { view?: string; limit?: number; mood?: string } = {}): TasteProfileView {
    const ts = this.now()
    const limit = Math.max(1, Math.min(50, Math.floor(req.limit ?? 10)))
    const state = this.store.readState()
    const base: TasteProfileView = {
      enabled: this.memory.enabled,
      onboarded: Boolean(this.memory.onboardedAt),
      snoozed: Boolean(this.memory.snoozedUntil && Date.parse(this.memory.snoozedUntil) > ts),
      summary: '',
      artists: [],
      tracks: [],
      sampleSize: 0,
      config: toConfigView(this.memory),
      ...(state.exploreStats ? { exploreStats: state.exploreStats } : {}),
    }
    if (!this.memory.enabled) {
      return { ...base, summary: '音乐画像已关闭。开启后会记录你的收听习惯并在本地生成口味画像。' }
    }

    const artists = this.store.top('artist', { now: ts, halfLifeDays: this.memory.halfLifeDays, limit, includeNegative: true })
    const tracks = this.store.top('track', { now: ts, halfLifeDays: this.memory.halfLifeDays, limit, includeNegative: true })
    const trackRows: TasteTrackRow[] = []
    for (const t of tracks) {
      const record = t as unknown as StoredTrack
      const ref = this.store.trackRef(t.key)
      if (!ref) continue
      trackRows.push({
        title: record.title ?? t.key.split('|')[0] ?? '',
        artist: record.artist ?? t.key.split('|')[1] ?? '',
        source: ref.source,
        id: ref.music.id,
        score: t.score,
        status: record.status ?? 'played',
        ...(record.lastPlayedAt !== undefined ? { lastPlayedAt: record.lastPlayedAt } : {}),
      })
    }
    const sampleSize = artists.reduce((sum, a) => sum + a.plays + a.skips, 0)
    const summary =
      artists.length > 0
        ? `近 ${this.memory.halfLifeDays} 天常听：${artists.filter((a) => a.score > 0).map((a) => a.raw ?? a.key).join('、') || '（暂无）'}`
        : '还没有收听记录。播放几首歌，或用「我喜欢」按钮显式告诉画像。'

    return {
      ...base,
      summary,
      artists: artists.map((a): TasteArtistRow => ({
        name: a.raw ?? a.key,
        score: a.score,
        plays: a.plays,
        skips: a.skips,
        confidence: a.confidence,
        explicit: a.explicit,
      })),
      tracks: trackRows,
      sampleSize,
    }
  }

  /** 最近事件（UI 的"证据"列表：让用户看到画像为什么长这样）。 */
  events(limit = 20): TasteEventRow[] {
    const rows = this.store.readEvents({ now: this.now(), retainDays: this.memory.retainDays })
    return rows
      .slice(-Math.max(1, Math.min(200, limit)))
      .reverse()
      .map((e) => ({
        ts: e.ts,
        kind: e.kind,
        origin: e.origin,
        mode: e.mode,
        title: e.title ?? '',
        artist: e.artist ?? '',
        ...(e.playedRatio !== undefined ? { playedRatio: e.playedRatio } : {}),
        reasons: (e.deltas ?? []).map((d) => `${d.key} ${d.signal > 0 ? '+' : ''}${d.signal}（${d.reason}）`),
      }))
  }

  /** 写操作（like/dislike/forget/note/清空）。UI 与工具共用。 */
  async action(req: TasteActionInput): Promise<TasteActionResult> {
    const ts = this.now()
    const action = req.action
    if (action === 'clear') {
      await this.store.clear()
      // 点歌/播放日志与画像同属「用户在本机留下的音乐数据」：一并清掉
      //（否则点了"清空"之后 logs/ 里还留着切歌记录）。
      let logsCleared = 0
      try {
        const logs = this.storage?.table('logs')
        if (logs) {
          for (const [key] of [...logs.entries()]) {
            await logs.delete(key)
            logsCleared += 1
          }
        }
      } catch (err) {
        this.onWarn('[lx-music-for-dsh] 清空点歌日志失败（画像已清空）', err)
      }
      // 域外遗留（旧版整份文件、音源兜底文件、插件状态文件）也一并删除；
      // domain 目录正被打开，交给卸载清理处理，这里不动。
      let leftovers = 0
      try {
        leftovers = cleanupLocalData({ includeDomain: false }).removed.length
      } catch (err) {
        this.onWarn('[lx-music-for-dsh] 清理遗留文件失败', err)
      }
      await this.store.appendEvent({ kind: 'forget', origin: 'user', mode: 'replay', ts, deltas: [] })
      const parts = ['画像', `点歌日志 ${logsCleared} 条`]
      if (leftovers > 0) parts.push(`遗留文件 ${leftovers} 个`)
      return { ok: true, message: `已清空本地音乐数据（${parts.join(' + ')}）。` }
    }
    if (!this.memory.enabled && action !== 'onboard' && action !== 'snooze') {
      return { ok: false, message: '音乐画像已关闭，请先在设置里开启。' }
    }
    switch (action) {
      case 'onboard': {
        await this.updateConfig({ onboardedAt: new Date(ts).toISOString(), enabled: true })
        return { ok: true, message: '已开启音乐画像。' }
      }
      case 'snooze': {
        await this.updateConfig({ snoozedUntil: new Date(ts + 7 * 86_400_000).toISOString() })
        return { ok: true, message: '好的，7 天内不再提示。' }
      }
      case 'like':
      case 'dislike': {
        const entity = (req.entity ?? '').trim()
        if (!entity) return { ok: false, message: '需要提供对象名称。' }
        const kind = req.kind === 'track' ? 'track' : req.kind === 'tag' ? 'tag' : 'artist'
        const key = kind === 'artist' ? normalizeArtist(entity) : entity
        const delta = explicitDelta({ kind, key, liked: action === 'like', provenance: 'explicit-ui' })
        await this.store.applyDeltas([delta], { now: ts, halfLifeDays: this.memory.halfLifeDays })
        await this.store.appendEvent({
          kind: action === 'like' ? 'like' : 'dislike',
          origin: 'user',
          mode: 'replay',
          ts,
          ...(kind === 'track' ? { trackKey: key } : { artistKey: key }),
          deltas: [delta],
        })
        return { ok: true, message: `已记录：${action === 'like' ? '喜欢' : '不喜欢'}「${entity}」` }
      }
      case 'forget': {
        const entity = (req.entity ?? '').trim()
        if (!entity) return { ok: false, message: '需要提供对象名称。' }
        const kind = req.kind === 'track' ? 'track' : req.kind === 'tag' ? 'tag' : 'artist'
        const key = kind === 'artist' ? normalizeArtist(entity) : entity
        const removed = await this.store.forget(kind, key)
        await this.store.appendEvent({ kind: 'forget', origin: 'user', mode: 'replay', ts, ...(kind === 'track' ? { trackKey: key } : { artistKey: key }) })
        return { ok: removed, message: removed ? `已忘掉「${entity}」` : `画像里没有「${entity}」` }
      }
      case 'note': {
        const note = (req.note ?? '').trim()
        if (!note) return { ok: false, message: '需要提供备注内容。' }
        await this.store.appendEvent({ kind: 'note', origin: 'user', mode: 'replay', ts, deltas: [] })
        await this.store.writeState({ ...this.store.readState(), summary: note })
        return { ok: true, message: '已记下这条备注。' }
      }
      default:
        return { ok: false, message: `未知操作：${action}` }
    }
  }

  /** 改配置（合并后归一化并落盘到 global.memory）。 */
  async updateConfig(patch: Record<string, unknown>): Promise<MemoryConfig> {
    // 显式开启必须留凭证（experimentalOptInAt）：normalizeMemoryConfig 只认这个标记，
    // 没有它时 enabled 会被强制按 false 处理（这样老版本默认开启时代写下的 true 不会继续生效）。
    const request =
      patch.enabled === true && typeof patch.experimentalOptInAt !== 'string'
        ? { ...patch, experimentalOptInAt: new Date(this.now()).toISOString() }
        : patch
    const merged = normalizeMemoryConfig({ ...this.memory, ...request })
    this.memory = merged
    this.onMemoryChange?.(merged)
    const storage = this.storage
    if (storage) {
      try {
        const current = storage.global.get()
        const base = current && typeof current === 'object' ? (current as Record<string, unknown>) : {}
        await storage.global.set({ ...base, memory: merged })
      } catch (err) {
        this.onWarn('[lx-music-for-dsh] 画像配置写入失败（本次运行仍生效）', err)
      }
    }
    return merged
  }
}
