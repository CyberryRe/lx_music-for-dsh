// 画像持久化 + 聚合（唯一的存储接触点）。
//
// 分层：events（按天分桶，append-only，唯一真源）→ 聚合表（tracks/artists/tags）→ state（摘要）。
// 所有数学都在 profile.ts（纯函数），这里只负责读写与裁剪。
//
// 表的使用方式刻意区分：
//   - 事件：**顺序追加**为主（读回来做重建/审计），所以按天分桶；
//   - 聚合：**按键随机访问**（排序、单条更新、遗忘某个艺人），所以一个实体一条记录。

import type { StorageFace } from '../playback'
import { storageKey } from '../storage/keys'
import type { MusicInfo } from '../shared/types'
import type { EntityDelta, TasteEntityKind, TasteEventKind, TasteEventMode, TasteEventOrigin, TasteProvenance } from './events'
import { applyDeltas, pruneEvents, topEntities, type EntityTable, type ProfileEntity, type RankedEntity } from './profile'
import {
  storedArtistSchema,
  storedTagSchema,
  storedTrackSchema,
  tasteEventDaySchema,
  tasteStateSchema,
  type ExploreStats,
  type StoredArtist,
  type StoredMusicInfo,
  type StoredTag,
  type StoredTrack,
  type TasteEventRecord,
  type TasteStateRecord,
} from './schema'

/** 画像表名（迁移与裁剪都要按这份清单走）。 */
export const TASTE_TABLES = ['taste_events', 'taste_tracks', 'taste_artists', 'taste_tags', 'taste_state'] as const

/** 每张聚合表的实体上限（超出时丢弃分数最低的，防止无限增长）。 */
export const ENTITY_LIMITS: Record<'taste_tracks' | 'taste_artists' | 'taste_tags', number> = {
  taste_tracks: 2000,
  taste_artists: 500,
  taste_tags: 200,
}

/** 事件按天分桶：一天最多留多少条。 */
export const MAX_EVENTS_PER_DAY = 200

const DAY_MS = 86_400_000

function tableOf(kind: TasteEntityKind): 'taste_tracks' | 'taste_artists' | 'taste_tags' {
  if (kind === 'track') return 'taste_tracks'
  if (kind === 'artist') return 'taste_artists'
  return 'taste_tags' // tag 与 strategy 共用一张表
}

/** 本地日期键 `YYYY-MM-DD`（事件分桶用；用本地时区，符合"我晚上听什么"的直觉）。 */
export function dayKey(ts: number, timezoneOffsetMinutes = new Date(ts).getTimezoneOffset()): string {
  const local = new Date(ts - timezoneOffsetMinutes * 60_000)
  const year = local.getUTCFullYear()
  const month = String(local.getUTCMonth() + 1).padStart(2, '0')
  const day = String(local.getUTCDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export interface TasteStoreOptions {
  now?: () => number
  /** 日志出口（双写由调用方决定）。 */
  onWarn?: (message: string, err?: unknown) => void
}

export interface AppendEventInput {
  kind: TasteEventKind
  origin: TasteEventOrigin
  mode: TasteEventMode
  ts: number
  trackKey?: string
  artistKey?: string
  title?: string
  artist?: string
  source?: string
  quality?: string
  playedRatio?: number
  replayed?: boolean
  context?: string
  deltas?: readonly EntityDelta[]
}

export interface ApplyResult {
  changed: string[]
  /** 按表统计的写入条数，便于测试与日志。 */
  written: Record<string, number>
}

/**
 * 画像存储门面。
 *
 * 注意所有方法都**不抛异常给调用方**（除了编程错误）：画像坏了不能影响放歌。
 * 写失败只记日志——这条约束由调用方（PlaybackService）保证不阻塞播放路径。
 */
export class TasteStore {
  private readonly now: () => number
  private readonly onWarn: (message: string, err?: unknown) => void
  /** 实体表的内存缓存（读时全量载入；实体数有上限，代价可控）。 */
  private cache: Partial<Record<'taste_tracks' | 'taste_artists' | 'taste_tags', EntityTable>> = {}

  constructor(
    private readonly storage: StorageFace,
    options: TasteStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.onWarn = options.onWarn ?? ((): void => {})
  }

  // -------------------------------------------------------------------------
  // 聚合表
  // -------------------------------------------------------------------------

  /** 载入某类实体（带缓存）。坏记录单独跳过，不影响其它实体。 */
  load(kind: TasteEntityKind): EntityTable {
    const table = tableOf(kind)
    const cached = this.cache[table]
    if (cached) return cached
    const schema = table === 'taste_tracks' ? storedTrackSchema : table === 'taste_artists' ? storedArtistSchema : storedTagSchema
    const loaded: EntityTable = {}
    try {
      for (const [key, value] of this.storage.table(table).entries()) {
        const parsed = schema.safeParse(value)
        if (!parsed.success) {
          this.onWarn(`[lx-music-for-dsh] 画像记录已跳过（不匹配 schema）: ${table}/${key}`)
          continue
        }
        loaded[key] = parsed.data as unknown as ProfileEntity
      }
    } catch (err) {
      this.onWarn(`[lx-music-for-dsh] 画像表读取失败: ${table}`, err)
    }
    this.cache[table] = loaded
    return loaded
  }

  /** 把信号应用到聚合表并落盘（返回变更的 key）。 */
  async applyDeltas(deltas: readonly EntityDelta[], options: { now?: number; halfLifeDays: number }): Promise<ApplyResult> {
    const now = options.now ?? this.now()
    const changed: string[] = []
    const written: Record<string, number> = {}
    // 按目标表分组，避免同一实体在两张表之间来回写
    const byTable = new Map<'taste_tracks' | 'taste_artists' | 'taste_tags', EntityDelta[]>()
    for (const delta of deltas) {
      const table = tableOf(delta.kind)
      const list = byTable.get(table)
      if (list) list.push(delta)
      else byTable.set(table, [delta])
    }

    for (const [table, tableDeltas] of byTable) {
      const kind: TasteEntityKind = table === 'taste_tracks' ? 'track' : table === 'taste_artists' ? 'artist' : 'tag'
      const current = this.load(kind)
      const result = applyDeltas(current, tableDeltas, {
        now,
        halfLifeDays: options.halfLifeDays,
        raw: (delta) => (kind === 'artist' ? delta.key : undefined),
      })
      this.cache[table] = result.table
      changed.push(...result.changed)
      // 只写变更过的实体；顺带做上限裁剪
      const pruned = this.pruneEntities(kind, result.table, now, options.halfLifeDays)
      this.cache[table] = pruned.kept
      let count = 0
      for (const key of result.changed) {
        const entity = pruned.kept[key]
        if (!entity) continue
        try {
          await this.storage.table(table).put(storageKey(key), this.serialize(kind, entity))
          count += 1
        } catch (err) {
          this.onWarn(`[lx-music-for-dsh] 画像写入失败: ${table}/${key}`, err)
        }
      }
      for (const key of pruned.removed) {
        try {
          await this.storage.table(table).delete(storageKey(key))
        } catch (err) {
          this.onWarn(`[lx-music-for-dsh] 画像裁剪失败: ${table}/${key}`, err)
        }
      }
      written[table] = count
    }
    return { changed: [...new Set(changed)], written }
  }

  /** 超出上限时按分数丢弃最低的（负分实体优先丢）。 */
  private pruneEntities(
    kind: TasteEntityKind,
    table: EntityTable,
    now: number,
    halfLifeDays: number,
  ): { kept: EntityTable; removed: string[] } {
    const limit = ENTITY_LIMITS[tableOf(kind)]
    const keys = Object.keys(table)
    if (keys.length <= limit) return { kept: table, removed: [] }
    const ranked = topEntities(table, { now, halfLifeDays, limit: keys.length, includeNegative: true })
    const keep = new Set(ranked.slice(0, limit).map((r) => r.key))
    const kept: EntityTable = {}
    const removed: string[] = []
    for (const key of keys) {
      if (keep.has(key)) kept[key] = table[key] as ProfileEntity
      else removed.push(key)
    }
    return { kept, removed }
  }

  /** 实体 → 持久化记录（补上 kind 与各表的专属字段）。 */
  private serialize(kind: TasteEntityKind, entity: ProfileEntity): StoredTrack | StoredArtist | StoredTag {
    const base = {
      key: entity.key,
      implicit: entity.implicit,
      explicit: entity.explicit,
      plays: entity.plays,
      skips: entity.skips,
      lastTs: entity.lastTs,
      updatedAt: entity.updatedAt,
    }
    if (kind === 'artist') {
      return { kind: 'artist', raw: entity.raw ?? entity.key, ...base } satisfies StoredArtist
    }
    if (kind === 'track') {
      const existing = this.cache.taste_tracks?.[entity.key] as StoredTrack | undefined
      return {
        kind: 'track',
        title: existing?.title ?? entity.raw ?? entity.key.split('|')[0] ?? entity.key,
        artist: existing?.artist ?? entity.key.split('|')[1] ?? '',
        status: existing?.status ?? 'played',
        ...(existing?.variant ? { variant: existing.variant } : {}),
        ...(existing?.album ? { album: existing.album } : {}),
        ...(existing?.durationSec !== undefined ? { durationSec: existing.durationSec } : {}),
        ...(existing?.lastSource ? { lastSource: existing.lastSource } : {}),
        ...(existing?.refs ? { refs: existing.refs } : {}),
        ...(existing?.lastPlayedAt !== undefined ? { lastPlayedAt: existing.lastPlayedAt } : {}),
        ...(existing?.lastExploredAt !== undefined ? { lastExploredAt: existing.lastExploredAt } : {}),
        ...base,
      } satisfies StoredTrack
    }
    const existingTag = this.cache.taste_tags?.[entity.key] as StoredTag | undefined
    return {
      kind: existingTag?.kind ?? (kind === 'tag' ? 'tag' : 'strategy'),
      ...(existingTag?.label ? { label: existingTag.label } : {}),
      ...(existingTag?.raw ? { raw: existingTag.raw } : {}),
      ...base,
    } satisfies StoredTag
  }

  // -------------------------------------------------------------------------
  // 曲目专属：可播放引用（Tier-1 直取）与 seen/played
  // -------------------------------------------------------------------------

  /**
   * 记下/更新某曲目在某平台的可播放引用。
   *
   * `status` 只在 `played=true` 时升级为 `played`；**只确认过身份（探索/严格匹配通过）
   * 绝不能标成 played**，否则"没听过的歌"池子会枯竭。
   */
  async upsertTrackRef(input: {
    trackKey: string
    title: string
    artist: string
    /** 收口用业务类型（MusicInfo）；schema 推断类型只在表内部使用，避免各调用点强转。 */
    music: MusicInfo
    album?: string
    durationSec?: number
    variant?: StoredTrack['variant']
    played: boolean
    explored?: boolean
    resolved?: boolean
    scriptName?: string
    now?: number
  }): Promise<void> {
    const now = input.now ?? this.now()
    const table = this.load('track')
    const existing = table[input.trackKey] as StoredTrack | undefined
    const refs = { ...(existing?.refs ?? {}) }
    const previous = refs[input.music.source]
    refs[input.music.source] = {
      music: input.music as StoredMusicInfo,
      ...(previous?.lastOkAt !== undefined ? { lastOkAt: previous.lastOkAt } : {}),
      ...(input.resolved ? { lastOkAt: now, lastResolvedAt: now } : previous?.lastOkAt !== undefined ? { lastOkAt: previous.lastOkAt } : {}),
      ...(input.scriptName ? { lastScript: input.scriptName } : previous?.lastScript ? { lastScript: previous.lastScript } : {}),
    }
    const record: StoredTrack = {
      kind: 'track',
      key: input.trackKey,
      title: existing?.title ?? input.title,
      artist: existing?.artist ?? input.artist,
      implicit: existing?.implicit ?? 0,
      explicit: existing?.explicit ?? 0,
      plays: existing?.plays ?? 0,
      skips: existing?.skips ?? 0,
      lastTs: existing?.lastTs ?? now,
      updatedAt: now,
      status: input.played || existing?.status === 'played' ? 'played' : 'seen',
      ...(input.variant ?? existing?.variant ? { variant: input.variant ?? existing?.variant } : {}),
      ...(input.album ?? existing?.album ? { album: input.album ?? existing?.album } : {}),
      ...(input.durationSec ?? existing?.durationSec ? { durationSec: input.durationSec ?? existing?.durationSec } : {}),
      lastSource: input.music.source,
      refs,
      ...(input.played ? { lastPlayedAt: now } : existing?.lastPlayedAt !== undefined ? { lastPlayedAt: existing.lastPlayedAt } : {}),
      ...(input.explored ? { lastExploredAt: now } : existing?.lastExploredAt !== undefined ? { lastExploredAt: existing.lastExploredAt } : {}),
    }
    table[input.trackKey] = record as unknown as ProfileEntity
    this.cache.taste_tracks = table
    try {
      await this.storage.table('taste_tracks').put(storageKey(input.trackKey), record)
    } catch (err) {
      this.onWarn(`[lx-music-for-dsh] 曲目引用写入失败: ${input.trackKey}`, err)
    }
  }

  /** 取某曲目的可播放引用（优先上次成功播放的平台，其次最近成功解析的）。 */
  trackRef(trackKey: string): { music: StoredMusicInfo; source: string } | undefined {
    const record = this.load('track')[trackKey] as StoredTrack | undefined
    const refs = record?.refs
    if (!refs) return undefined
    const preferred = record?.lastSource && refs[record.lastSource] ? record.lastSource : undefined
    const fallback = Object.entries(refs).sort((a, b) => (b[1].lastOkAt ?? 0) - (a[1].lastOkAt ?? 0))[0]?.[0]
    const source = preferred ?? fallback
    if (!source) return undefined
    const entry = refs[source]
    if (!entry) return undefined
    return { music: entry.music, source }
  }

  /** 某曲目是否已经"真的播过"（探索池用）。 */
  hasPlayed(trackKey: string): boolean {
    const record = this.load('track')[trackKey] as StoredTrack | undefined
    return record?.status === 'played'
  }

  /**
   * 按平台 + 曲目 id 反查已确认的可播放引用（Tier-1 直取的另一条入口）。
   *
   * 为什么需要：`music_play_song({source,id})` 只给了平台 id，没有曲名/艺人，
   * 无法直接算出 trackKey。曲目表有上限（≤2000），线性扫描代价可忽略。
   */
  findByRef(source: string, id: string): { trackKey: string; record: StoredTrack; music: StoredMusicInfo } | undefined {
    for (const [trackKey, value] of Object.entries(this.load('track'))) {
      const record = value as StoredTrack
      const entry = record.refs?.[source]
      if (entry && entry.music.id === id) return { trackKey, record, music: entry.music }
    }
    return undefined
  }

  /** 忘记单个实体（设置页与 music_taste(forget) 用）。 */
  async forget(kind: TasteEntityKind, key: string): Promise<boolean> {
    const table = tableOf(kind)
    const current = this.load(kind)
    if (!(key in current)) return false
    delete current[key]
    this.cache[table] = current
    try {
      await this.storage.table(table).delete(storageKey(key))
    } catch (err) {
      this.onWarn(`[lx-music-for-dsh] 画像遗忘失败: ${table}/${key}`, err)
    }
    return true
  }

  /** 已听曲目 key 集合（探索排除用）。 */
  playedKeys(): Set<string> {
    const table = this.load('track')
    const keys = new Set<string>()
    for (const [key, value] of Object.entries(table)) {
      if ((value as StoredTrack).status === 'played') keys.add(key)
    }
    return keys
  }

  /** 冷却期内探索过的曲目 key 集合（同一首歌不重复探索，§18.2 去重窗口）。 */
  recentlyExplored(now: number, days: number): Set<string> {
    const cutoff = now - days * DAY_MS
    const keys = new Set<string>()
    for (const [key, value] of Object.entries(this.load('track'))) {
      const record = value as StoredTrack
      if (record.lastExploredAt !== undefined && record.lastExploredAt >= cutoff) keys.add(key)
    }
    return keys
  }

  // -------------------------------------------------------------------------
  // 事件流（唯一真源）
  // -------------------------------------------------------------------------

  /** 追加一条事件到当天的桶里（同一天超过上限时丢弃最旧的）。 */
  async appendEvent(input: AppendEventInput): Promise<void> {
    const key = dayKey(input.ts)
    const table = this.storage.table('taste_events')
    let day: { date: string; events: TasteEventRecord[] } = { date: key, events: [] }
    try {
      const parsed = tasteEventDaySchema.safeParse(table.get(storageKey(key)))
      if (parsed.success) day = parsed.data
    } catch (err) {
      this.onWarn(`[lx-music-for-dsh] 事件桶读取失败，将重建: ${key}`, err)
    }
    const record: TasteEventRecord = {
      ts: input.ts,
      kind: input.kind,
      origin: input.origin,
      mode: input.mode,
      ...(input.trackKey ? { trackKey: input.trackKey } : {}),
      ...(input.artistKey ? { artistKey: input.artistKey } : {}),
      ...(input.title ? { title: input.title } : {}),
      ...(input.artist ? { artist: input.artist } : {}),
      ...(input.source ? { source: input.source } : {}),
      ...(input.quality ? { quality: input.quality } : {}),
      ...(input.playedRatio !== undefined ? { playedRatio: input.playedRatio } : {}),
      ...(input.replayed !== undefined ? { replayed: input.replayed } : {}),
      ...(input.context ? { context: input.context } : {}),
      ...(input.deltas && input.deltas.length > 0
        ? {
            deltas: input.deltas.map((d) => ({
              kind: d.kind,
              key: d.key,
              signal: d.signal,
              reason: d.reason,
              provenance: d.provenance as TasteProvenance,
              ...(d.sample === false ? { sample: false } : {}),
            })),
          }
        : {}),
    }
    const events = [...day.events, record]
    const trimmed = events.length > MAX_EVENTS_PER_DAY ? events.slice(events.length - MAX_EVENTS_PER_DAY) : events
    try {
      await table.put(storageKey(key), { date: key, events: trimmed })
    } catch (err) {
      this.onWarn(`[lx-music-for-dsh] 事件写入失败: ${key}`, err)
    }
  }

  /** 读取保留窗口内的事件（按时间升序）。 */
  readEvents(options: { now?: number; retainDays: number; maxRecords?: number }): TasteEventRecord[] {
    const now = options.now ?? this.now()
    const all: TasteEventRecord[] = []
    try {
      for (const [key, value] of this.storage.table('taste_events').entries()) {
        const parsed = tasteEventDaySchema.safeParse(value)
        if (!parsed.success) {
          this.onWarn(`[lx-music-for-dsh] 事件桶已跳过（不匹配 schema）: ${key}`)
          continue
        }
        all.push(...parsed.data.events)
      }
    } catch (err) {
      this.onWarn('[lx-music-for-dsh] 事件表读取失败', err)
    }
    const sorted = all.sort((a, b) => a.ts - b.ts)
    return pruneEvents(sorted, { now, retainDays: options.retainDays, ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}) })
  }

  /** 删掉保留窗口之外的事件桶（键就是日期，直接比较字符串即可）。 */
  async pruneEvents(options: { now?: number; retainDays: number }): Promise<string[]> {
    const now = options.now ?? this.now()
    const cutoffKey = dayKey(now - options.retainDays * DAY_MS)
    const removed: string[] = []
    try {
      for (const [key] of this.storage.table('taste_events').entries()) {
        if (key < cutoffKey) {
          await this.storage.table('taste_events').delete(key)
          removed.push(key)
        }
      }
    } catch (err) {
      this.onWarn('[lx-music-for-dsh] 事件裁剪失败', err)
    }
    return removed
  }

  // -------------------------------------------------------------------------
  // 摘要状态
  // -------------------------------------------------------------------------

  readState(): TasteStateRecord {
    try {
      const parsed = tasteStateSchema.safeParse(this.storage.table('taste_state').get(storageKey('summary')))
      if (parsed.success) return parsed.data
    } catch (err) {
      this.onWarn('[lx-music-for-dsh] 画像状态读取失败', err)
    }
    return {}
  }

  async writeState(state: TasteStateRecord): Promise<void> {
    try {
      await this.storage.table('taste_state').put(storageKey('summary'), state)
    } catch (err) {
      this.onWarn('[lx-music-for-dsh] 画像状态写入失败', err)
    }
  }

  /** 探索/复听的计数（自适应探索率与分组评估用，见设计文档 §18.2）。 */
  async bumpExploreStats(mode: TasteEventMode, outcome: 'play' | 'skip', currentRatio: number): Promise<ExploreStats> {
    const state = this.readState()
    const base: ExploreStats = state.exploreStats ?? { replayPlays: 0, replaySkips: 0, explorePlays: 0, exploreSkips: 0, exploreRatio: currentRatio }
    const next: ExploreStats = {
      ...base,
      replayPlays: base.replayPlays + (mode === 'replay' && outcome === 'play' ? 1 : 0),
      replaySkips: base.replaySkips + (mode === 'replay' && outcome === 'skip' ? 1 : 0),
      explorePlays: base.explorePlays + (mode === 'explore' && outcome === 'play' ? 1 : 0),
      exploreSkips: base.exploreSkips + (mode === 'explore' && outcome === 'skip' ? 1 : 0),
    }
    await this.writeState({ ...state, exploreStats: next })
    return next
  }

  /** 取排行（工具与 UI 都用它）。`includeNegative` 用于展示"明确不喜欢"的黑名单。 */
  top(
    kind: TasteEntityKind,
    options: { now?: number; halfLifeDays: number; limit?: number; minPurpose?: 'tiebreak' | 'rerank' | 'proactive'; includeNegative?: boolean },
  ): RankedEntity[] {
    return topEntities(this.load(kind), {
      now: options.now ?? this.now(),
      halfLifeDays: options.halfLifeDays,
      limit: options.limit ?? 10,
      ...(options.minPurpose ? { minPurpose: options.minPurpose } : {}),
      ...(options.includeNegative ? { includeNegative: true } : {}),
    })
  }

  /** 彻底清空画像（设置页"一键清空"）。 */
  async clear(): Promise<void> {
    this.cache = {}
    for (const table of TASTE_TABLES) {
      try {
        const handle = this.storage.table(table)
        const keys = [...handle.entries()].map(([key]) => key)
        for (const key of keys) await handle.delete(key)
      } catch (err) {
        this.onWarn(`[lx-music-for-dsh] 画像清空失败: ${table}`, err)
      }
    }
  }
}
