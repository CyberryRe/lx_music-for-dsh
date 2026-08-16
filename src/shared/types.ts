// Shared types between the host plugin and the browser client.
// This file must stay free of runtime imports that the client bundle cannot resolve
// (only type exports + plain consts are allowed here).

/** LX Music 平台标识（lxserver / lx-music-desktop 通用）。 */
export type MusicSource = 'kw' | 'wy' | 'kg' | 'tx' | 'mg' | 'local'

/** 音质标识。 */
export type Quality = '128k' | '320k' | 'flac' | 'flac24bit' | 'flac32bit' | 'wav'

/** 音质 + 大小，如 { type: '320k', size: '9.32M' }。 */
export interface MusicQualityType {
  type: Quality
  size: string | null
}

/** 歌曲元数据（与 LX.Music.MusicInfoMeta_online 对齐）。 */
export interface MusicMeta {
  songId: string | number
  albumName?: string
  albumId?: string | number
  picUrl?: string | null
  qualitys?: MusicQualityType[]
  // 平台特有字段
  hash?: string // kg
  copyrightId?: string // mg
  lrcUrl?: string // mg
  mrcUrl?: string // mg
  trcUrl?: string // mg
  strMediaMid?: string // tx
  albumMid?: string // tx
  id?: number // tx
}

/** 歌曲信息（LX.Music.MusicInfo 对齐）。 */
export interface MusicInfo {
  id: string
  name: string
  singer: string
  source: MusicSource
  interval: string | null
  meta: MusicMeta
}

/** 播放状态（LX.Player.Status 对齐的轻量版）。 */
export type PlaybackStatus = 'playing' | 'paused' | 'error' | 'stoped'

/**
 * 播放模式：
 * - list：列表循环（播完最后一首回到第一首，默认）
 * - single：单曲循环（当前曲目播完自动重播）
 * - order：顺序播放（播完最后一首停止）
 * - shuffle：随机播放（自动/手动切歌时随机选曲）
 */
export type PlayMode = 'list' | 'single' | 'order' | 'shuffle'

/** 直链解析结果。 */
export interface MusicUrlResult {
  url: string
  type: Quality
  sourceName?: string
  attempts?: Array<{ name: string; status: 'success' | 'fail'; message?: string }>
}

/** 播放器权威状态（host 持有，client 轮询）。 */
export interface PlayerState {
  playlist: MusicInfo[]
  currentIndex: number // -1 表示无
  status: PlaybackStatus
  progress: number // 秒
  duration: number // 秒
  current: MusicInfo | null
  quality: Quality
  volume: number // 0-1
  mute: boolean
  playMode: PlayMode // 列表循环/单曲循环/顺序播放/随机播放
  version: number // 状态版本号，client 用于 diff
}

/** 添加位置。 */
export type AddPosition = 'tail' | 'next'

/** 搜索请求。 */
export interface SearchRequest {
  query: string
  singer?: string
  sources?: MusicSource[] // 平台优先级；缺省用设置
  limit?: number
  type?: 'song' | 'singer' | 'album' | 'playlist'
}

/** 搜索结果（单平台）。 */
export interface SearchResult {
  source: MusicSource
  list: MusicInfo[]
  error?: string
}

/** 搜索汇总结果。 */
export interface SearchOutcome {
  results: MusicInfo[]
  usedSource: MusicSource | null
  attempts: Array<{ source: MusicSource; status: 'success' | 'fail'; count: number; error?: string }>
}

/** 音源元数据（lxserver /api/custom-source/list 条目）。 */
export interface SourceEntry {
  id: string
  name: string
  version?: string
  author?: string
  description?: string
  homepage?: string
  size?: number
  supportedSources?: string[]
  enabled: boolean
  owner?: string
  isPublic?: boolean
  status?: 'success' | 'failed'
  error?: string
  sourceUrl?: string
  uploadTime?: string
  requireUnsafe?: boolean
}

/** 插件设置。 */
export interface PluginSettings {
  /** LX Music 服务端地址，空字符串 = 使用内置 mock。 */
  lxServerUrl: string
  /** 全局默认音质。 */
  defaultQuality: Quality
  /** 音质降级链（解析失败时依次尝试）。 */
  qualityFallbackChain: Quality[]
  /** 平台优先级（搜索顺序）。 */
  platformPriority: MusicSource[]
  /** 每个音源自定义平台优先级（key=音源 id，缺省用 platformPriority）。 */
  perSourcePlatformPriority: Record<string, MusicSource[]>
  /** 切歌时是否自动拉取最高音质。 */
  autoPullHighestOnSwitch: boolean
  /** 拉取失败时的降级策略。 */
  fallbackStrategy: 'next-quality' | 'next-platform' | 'both'
  /** LLM 点歌限流：每分钟调用上限。 */
  rateLimitPerMinute: number
  /**
   * 数据源模式：auto=有 lxServerUrl 用 lxserver 否则用内置引擎；
   * engine=内置引擎（SDK 搜索 + 音源脚本直链，完全独立）；
   * lxserver=服务端；mock=内置演示数据。
   */
  providerMode: 'auto' | 'engine' | 'lxserver' | 'mock'
}

/** 点歌日志条目。 */
export interface PlayLogEntry {
  time: string // ISO
  /** 操作类型：search / play / playlist.add / next / prev / control.* / search_and_play 等。 */
  action?: string
  query: string
  limit: number
  autoPlay: boolean
  source: MusicSource | null
  resultsCount: number
  playedId: string | null
  latencyMs: number
  error?: string
}

/** 默认设置。 */
export const DEFAULT_SETTINGS: PluginSettings = {
  lxServerUrl: '',
  defaultQuality: '320k',
  qualityFallbackChain: ['flac', '320k', '128k'],
  platformPriority: ['wy', 'tx', 'kg', 'kw', 'mg'],
  perSourcePlatformPriority: {},
  autoPullHighestOnSwitch: true,
  fallbackStrategy: 'both',
  rateLimitPerMinute: 6,
  providerMode: 'auto',
}

/** Remote 调用返回值包装。 */
export interface Answered<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

/** search_and_play 工具输入。 */
export interface SearchAndPlayArgs {
  query: string
  limit?: number
  auto_play?: boolean
  source?: MusicSource
}

/** search_and_play 工具输出（JSON Schema 字面量对齐：可空值用空字符串）。 */
export interface SearchAndPlayOutput {
  results: Array<{
    id: string
    name: string
    singer: string
    source: string
    interval: string
    qualitys: Array<{ type: string; size: string }>
    picUrl: string
    /** 直链预览（解析失败为空字符串）。 */
    url: string
  }>
  played: boolean
  playlistPosition: number
  note?: string
}

/** 搜索结果条目（music_search / search_and_play 通用）。 */
export interface SearchResultItem {
  id: string
  name: string
  singer: string
  source: string
  interval: string
  qualitys: Array<{ type: string; size: string }>
  picUrl: string
  /** 直链预览（未解析或解析失败为空字符串）。 */
  url: string
}

/** music_search 工具输入。 */
export interface MusicSearchArgs {
  query: string
  limit?: number
  source?: MusicSource
  singer?: string
  with_url?: boolean
}

/** music_search 工具输出。 */
export interface MusicSearchOutput {
  results: SearchResultItem[]
  usedSource: string
  note: string
}

/** music_play 工具输入（query 与 index 二选一）。 */
export interface MusicPlayArgs {
  /** 搜索关键词：搜索并播放（与 index 二选一）。 */
  query?: string
  /** 播放列表序号（从 0 开始，与 query 二选一）。 */
  index?: number
  /** query 搜索结果的第几首（从 0 开始），默认 0。 */
  result_index?: number
  /** 指定搜索平台。 */
  source?: MusicSource
  /** 是否立即播放，默认 true；false 时仅加入播放列表。 */
  auto_play?: boolean
  /** 加入播放列表的位置：tail=队尾（默认）/ next=当前曲目之后。 */
  position?: AddPosition
}

/** 播放状态摘要（工具输出共用）。 */
export interface MusicStateSummary {
  played: boolean
  playlistPosition: number
  current: { name: string; singer: string; source: string } | null
  status: string
  playlistCount: number
}

/** music_play 工具输出。 */
export interface MusicPlayOutput extends MusicStateSummary {
  note: string
}

/** music_prev / music_next 工具输出。 */
export type MusicNavOutput = MusicStateSummary

/** 播放列表操作。 */
export type MusicPlaylistAction = 'list' | 'add' | 'remove' | 'clear' | 'export'

/** music_playlist 工具输入。 */
export interface MusicPlaylistArgs {
  action: MusicPlaylistAction
  /** add：搜索关键词。 */
  query?: string
  /** add：加入数量，默认 5（1-20）。 */
  limit?: number
  /** add：指定搜索平台。 */
  source?: MusicSource
  /** add：加入位置 tail/next，默认 tail。 */
  position?: AddPosition
  /** remove：序号（从 0 开始，与 id 二选一）。 */
  index?: number
  /** remove：歌曲 id（与 index 二选一）。 */
  id?: string
}

/** music_playlist 工具输出。 */
export interface MusicPlaylistOutput {
  action: string
  count: number
  currentIndex: number
  playlist: Array<{ index: number; id: string; name: string; singer: string; source: string; interval: string }>
  /** export 操作时的文本导出。 */
  text?: string
  note: string
}

/** 播放控制操作。 */
export type MusicControlAction = 'toggle' | 'pause' | 'resume' | 'seek' | 'volume' | 'quality' | 'playMode'

/** music_control 工具输入。 */
export interface MusicControlArgs {
  action: MusicControlAction
  /** seek：目标进度（秒）。 */
  seconds?: number
  /** volume：音量 0-1。 */
  volume?: number
  /** quality：目标音质。 */
  quality?: Quality
  /** playMode：列表循环/单曲循环/顺序播放/随机播放。 */
  play_mode?: PlayMode
}

/** music_control 工具输出。 */
export interface MusicControlOutput extends MusicStateSummary {
  action: string
  volume: number
  quality: string
  playMode: string
  note: string
}

/** 格式化时长 "03:55" → 秒。 */
export function intervalToSeconds(interval: string | null): number {
  if (!interval) return 0
  const parts = interval.split(':').map((p) => Number(p) || 0)
  if (parts.length === 3) return (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
  if (parts.length === 2) return (parts[0] ?? 0) * 60 + (parts[1] ?? 0)
  return parts[0] ?? 0
}

/** 秒 → "mm:ss"。 */
export function secondsToInterval(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`
}
