// Shared types between the host plugin and the browser client.
// This file must stay free of runtime imports that the client bundle cannot resolve
// (only type exports + plain consts are allowed here).

/** LX Music 平台标识（lxserver / lx-music-desktop 通用）。 */
export type MusicSource = 'kw' | 'wy' | 'kg' | 'tx' | 'mg' | 'local'

/**
 * 全部在线平台（不含 `local`），用于工具参数枚举、UI 平台下拉等"列出所有平台"的场景。
 * 需要"按优先级依次尝试"时用 {@link DEFAULT_PLATFORM_PRIORITY}，两者顺序**刻意不同**。
 */
export const MUSIC_SOURCES: MusicSource[] = ['kw', 'wy', 'kg', 'tx', 'mg']

/** 默认搜索优先级（`DEFAULT_SETTINGS.platformPriority` 的初值）。 */
export const DEFAULT_PLATFORM_PRIORITY: MusicSource[] = ['wy', 'tx', 'kg', 'kw', 'mg']

/**
 * 平台显示名（UI 用）。
 *
 * 放在这里而不是各 UI 组件里：此前 MainWindow 与 SettingsWindow 各写了一份完全相同的表，
 * 新增平台时很容易只改一处。
 */
export const SOURCE_LABEL: Record<MusicSource, string> = {
  kw: '酷我',
  wy: '网易云',
  kg: '酷狗',
  tx: 'QQ音乐',
  mg: '咪咕',
  local: '本地',
}

/** 取平台显示名；未知平台原样返回（第三方来源/音源脚本自定义标识不应显示成空白）。 */
export function sourceLabel(source: string): string {
  return (SOURCE_LABEL as Record<string, string>)[source] ?? source
}

/** 音质标识。 */
export type Quality = '128k' | '320k' | 'flac' | 'flac24bit' | 'flac32bit' | 'wav'

/** 全部音质（从低到高）：工具参数枚举与设置窗口下拉共用同一份，避免各处手写数组。 */
export const QUALITIES: Quality[] = ['128k', '320k', 'flac', 'flac24bit', 'flac32bit', 'wav']

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

/**
 * 全部播放模式（值的全集，工具参数枚举用）。
 *
 * UI 的「点击循环切换」顺序是另一回事（列表循环 → 单曲循环 → 随机播放 → 顺序播放），
 * 连图标与文案一起定义在 `src/ui/playModes.ts`；这里只管"有哪些值"。
 */
export const PLAY_MODE_VALUES: PlayMode[] = ['list', 'single', 'order', 'shuffle']

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
  platformPriority: [...DEFAULT_PLATFORM_PRIORITY],
  perSourcePlatformPriority: {},
  autoPullHighestOnSwitch: true,
  fallbackStrategy: 'both',
  rateLimitPerMinute: 6,
  providerMode: 'auto',
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

// ── 音乐画像（1.2.0）：host 门面与 client UI 共用的形状 ──────────────────────

/** 画像配置在 UI 上的形状（与 host 侧 MemoryConfig 结构一致）。 */
export interface MemoryConfigView {
  enabled: boolean
  /** 实验性功能标记：UI 据此显示红色警示（当前恒为 true，打磨完成后移除）。 */
  experimental?: boolean
  /** 显式开启凭证（ISO）；缺失表示用户从未确认过，enabled 必为 false。 */
  experimentalOptInAt?: string
  onboardedAt?: string
  snoozedUntil?: string
  halfLifeDays: number
  retainDays: number
  budget: 'off' | 'minimal' | 'balanced' | 'rich'
  semanticProfile: 'off' | 'local-only' | 'llm-assisted'
  profileCallsPerHour: number
  exploreRatio: number
  migratedFrom?: string
}

export interface TasteArtistRow {
  name: string
  score: number
  plays: number
  skips: number
  confidence: string
  explicit: number
}

export interface TasteTrackRow {
  title: string
  artist: string
  source: string
  id: string
  score: number
  status: string
  lastPlayedAt?: number
}

export interface TasteEventRow {
  ts: number
  kind: string
  origin: string
  mode: string
  title: string
  artist: string
  playedRatio?: number
  reasons: string[]
}

/** 画像视图（`lxPlayback.getTasteProfile` 的返回形状）。 */
export interface TasteProfileView {
  enabled: boolean
  onboarded: boolean
  snoozed: boolean
  summary: string
  artists: TasteArtistRow[]
  tracks: TasteTrackRow[]
  sampleSize: number
  config: MemoryConfigView | null
  exploreStats?: { replayPlays: number; replaySkips: number; explorePlays: number; exploreSkips: number; exploreRatio: number }
}

export interface TasteActionInput {
  action: string
  kind?: string
  entity?: string
  note?: string
}

export interface TasteActionResult {
  ok: boolean
  message: string
}

// ── 歌词（1.3.0）─────────────────────────────────────────────────────────────

/**
 * 歌词来源。
 *
 * 解析顺序（见 `src/engine/musicEngine.ts` 的 `resolveLyric`）：
 * 1. `script`  —— 已启用的音源脚本实现的 `lyric` action（音源自带的歌词接口，最贴近播放的直链）
 * 2. `sdk`     —— 内置 SDK 的五平台歌词接口
 * 3. `lxserver`—— providerMode=lxserver 时的服务端歌词
 * 4. `mock`    —— 演示数据源
 * `none` = 都没拿到（此时 `LyricDoc.note` 里有原因）。
 */
export type LyricSource = 'script' | 'sdk' | 'lxserver' | 'mock' | 'none'

/** 逐字时间轴片段（时间相对**行首**，毫秒）。 */
export interface LyricWord {
  /** 起始（相对行首，毫秒，已 clamp 到 ≥0）。 */
  time: number
  /** 时长（毫秒）；缺失/非法按 0 处理。 */
  duration: number
  text: string
}

/** 一行歌词（结构化后）。 */
export interface LyricLine {
  /** 绝对时间（秒，**已应用 [offset:]**）。 */
  time: number
  text: string
  /** 翻译（tlyric）。 */
  tr?: string
  /** 音译（rlyric）。 */
  ro?: string
  /** 逐字时间轴（仅部分平台有：wy/kg/kw/mg 的逐字歌词）。 */
  words?: LyricWord[]
  /** 该行持续时间（秒）：到下一行的时间差；末行用兜底值。 */
  duration: number
}

/** 解析后的歌词文档（host 解析，client 只渲染）。 */
export interface LyricDoc {
  source: LyricSource
  /** 实际命中的平台（诊断/UI 角标用）；音源脚本命中的是歌曲自身的 platform。 */
  platform?: MusicSource
  /** 命中的原始格式：lrc / lxlyric / krc / mrc / script / none。 */
  format: string
  lines: LyricLine[]
  /** `[offset:]`（毫秒，正数 = 歌词提前显示）。 */
  offset: number
  hasTranslation: boolean
  hasWordTiming: boolean
  /**
   * 歌词只有纯文本、没有时间标签（已按估算间隔补出伪时间轴）。
   * UI 可以据此提示"该平台未提供时间轴"。
   */
  plain: boolean
  /** 歌词覆盖的时长（秒）；0 = 未知。 */
  duration: number
  /** 诊断信息（无歌词/降级原因；UI 在空状态下直接展示）。 */
  note?: string
}

/** 歌词不可用时的空文档（UI 与工具都靠它拿到可展示的原因）。 */
export function emptyLyricDoc(note: string, source: LyricSource = 'none', format = 'none'): LyricDoc {
  return { source, format, lines: [], offset: 0, hasTranslation: false, hasWordTiming: false, plain: false, duration: 0, note }
}

// ── 系统媒体控件（SMTC / MediaSession）状态（1.3.0）──────────────────────────

/**
 * 插件推送给系统媒体面板的状态（client 侧自检用）。
 *
 * 系统面板（Windows SMTC / macOS Now Playing）**没有回读 API**，所以"到底推出去了什么"
 * 只能在插件里自己记一份，再显示给用户 —— 否则"SMTC 还是显示会话名"这类问题无法自查。
 */
export interface SmtcStatus {
  /** 当前内核是否有 `navigator.mediaSession`。 */
  supported: boolean
  /** 已推送的标题（未推送为空串）。 */
  title: string
  artist: string
  /** 已推送的封面 URL（未推送为空串）。 */
  artwork: string
  /** 封面是否写进了 MediaMetadata。 */
  artworkPushed: boolean
  /** `playing` / `paused` / `none`。 */
  playbackState: string
  /** 降级或异常说明（不支持、setActionHandler 失败等）。 */
  note?: string
}
