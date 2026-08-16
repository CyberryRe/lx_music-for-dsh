// PlaybackService：播放权威状态（host 侧 Typert Remote 服务）。
// - 持有播放列表、当前曲目、播放状态、音质、音量
// - client 是音频执行端：轮询 getState()，执行 audio 播放并上报 reportProgress
// - LLM 工具与 client UI 通过同一服务操作，保证两端状态一致
// - 通过 storage domain 持久化（列表/索引/设置/日志）

import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import type {
  AddPosition,
  MusicInfo,
  MusicUrlResult,
  PlayLogEntry,
  PlayMode,
  PlayerState,
  PluginSettings,
  PlaybackStatus,
  Quality,
  SearchOutcome,
  SearchRequest,
  SourceEntry,
} from './shared/types'
import { DEFAULT_SETTINGS, intervalToSeconds } from './shared/types'
import { jsonSafe } from './shared/json'
import { getSandboxRequestLog } from './engine/sandbox'
import { createProvider, migrateMockMode, type Provider } from './provider'
import type { RateLimitStatus } from './ratelimit'

export interface StorageFace {
  global: {
    get(): unknown
    set(value: unknown): Promise<void>
  }
  table(name: string): {
    get(key: string): unknown
    put(key: string, value: unknown): Promise<void>
    entries(): IterableIterator<[string, unknown]>
    delete(key: string): Promise<boolean>
  }
}

interface PersistedState {
  playlist: MusicInfo[]
  currentIndex: number
  quality: Quality
  volume: number
  mute: boolean
  playMode?: PlayMode
  settings?: PluginSettings
}

/** 音质优先级（用于"最高音质"选择与降级链）。 */
const QUALITY_RANK: Record<Quality, number> = {
  flac32bit: 6,
  flac24bit: 5,
  flac: 4,
  wav: 3,
  '320k': 2,
  '128k': 1,
}

function rankQuality(q: Quality): number {
  return QUALITY_RANK[q] ?? 0
}

/** 从歌曲支持的音质中选择目标音质。 */
export function pickQuality(music: MusicInfo, settings: PluginSettings, explicit?: Quality): Quality {
  const supported = new Set((music.meta.qualitys ?? []).map((q) => q.type))
  const candidates = explicit
    ? [explicit, ...settings.qualityFallbackChain.filter((q) => q !== explicit)]
    : settings.autoPullHighestOnSwitch
      ? settings.qualityFallbackChain
      : [settings.defaultQuality, ...settings.qualityFallbackChain.filter((q) => q !== settings.defaultQuality)]
  for (const q of candidates) {
    if (supported.has(q)) return q
  }
  // 歌曲未声明音质 → 取 fallback 链首位（或默认）
  return settings.qualityFallbackChain[0] ?? settings.defaultQuality ?? '128k'
}

export interface PlaybackServiceOptions {
  /** 持久化存储（可选：不提供则仅内存）。 */
  storage?: StorageFace
  /** 初始设置（缺省用 DEFAULT_SETTINGS）。 */
  settings?: PluginSettings
  /** 设置变更回调（index.ts 用于写回 storage）。 */
  onSettingsChange?: (settings: PluginSettings) => void
  /** 日志写入回调（index.ts 用于写 storage 日志表）。 */
  onLog?: (entry: PlayLogEntry) => void
  /** 限流器（tools 使用；service 内部持有引用）。 */
  rateLimiter?: { tryConsume(now?: number): RateLimitStatus; reset(): void }
  now?: () => number
}

export class PlaybackService extends TypertRemoteService {
  static inject = []

  private state: PlayerState
  private settings: PluginSettings
  private provider: Provider
  private readonly storage?: StorageFace
  private readonly onSettingsChange?: (s: PluginSettings) => void
  private readonly onLog?: (e: PlayLogEntry) => void
  readonly rateLimiter?: PlaybackServiceOptions['rateLimiter']
  private readonly now: () => number
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private urlCache = new Map<string, MusicUrlResult>()

  constructor(ctx: Context, options: PlaybackServiceOptions = {}) {
    super(ctx, 'lxPlayback')
    this.storage = options.storage
    this.onSettingsChange = options.onSettingsChange
    this.onLog = options.onLog
    this.rateLimiter = options.rateLimiter
    this.now = options.now ?? Date.now
    this.settings = { ...DEFAULT_SETTINGS, ...options.settings }

    const persisted = this.loadPersisted()
    // 持久化设置覆盖默认/行配置设置（UI 保存的设置优先）
    if (persisted.settings && typeof persisted.settings === 'object') {
      const persistedSettings = persisted.settings as PluginSettings & { mockMode?: string }
      this.settings = { ...this.settings, ...persistedSettings }
      // 旧版 mockMode 字段迁移
      if (persistedSettings.mockMode !== undefined && this.settings.providerMode === undefined) {
        this.settings.providerMode = migrateMockMode(persistedSettings.mockMode)
      }
    }
    this.state = {
      playlist: persisted.playlist,
      currentIndex: persisted.currentIndex,
      status: persisted.currentIndex >= 0 ? 'paused' : 'stoped',
      progress: 0,
      duration: persisted.playlist[persisted.currentIndex] ? intervalToSeconds(persisted.playlist[persisted.currentIndex]!.interval) : 0,
      current: persisted.currentIndex >= 0 ? (persisted.playlist[persisted.currentIndex] ?? null) : null,
      quality: persisted.quality,
      volume: persisted.volume,
      mute: persisted.mute,
      playMode: persisted.playMode ?? 'list',
      version: 1,
    }
    this.provider = this.buildProvider()
  }

  /** 依据当前设置重建 provider（lxServerUrl/mockMode 变更后调用）。 */
  refreshProvider(): void {
    this.provider = this.buildProvider()
  }

  private buildProvider(): Provider {
    try {
      return createProvider(this.settings, { storage: this.storage })
    } catch (err) {
      // providerMode:lxserver 且无地址等配置错误 → 回退内置引擎并记录
      console.warn('[lxPlayback] provider 创建失败，回退内置引擎:', err instanceof Error ? err.message : err)
      return createProvider({ lxServerUrl: '', providerMode: 'engine' }, { storage: this.storage })
    }
  }

  /** 释放 provider 持有的资源（音源子进程等）；插件卸载时由 index.ts 调用。 */
  disposeProvider(): void {
    const p = this.provider as { dispose?: () => void } | undefined
    p?.dispose?.()
  }

  private loadPersisted(): { playlist: MusicInfo[]; currentIndex: number; quality: Quality; volume: number; mute: boolean; playMode?: PlayMode; settings?: PluginSettings } {
    const fallback: PersistedState = { playlist: [], currentIndex: -1, quality: this.settings.defaultQuality, volume: 1, mute: false }
    if (!this.storage) return fallback
    try {
      const raw = this.storage.global.get() as Partial<PersistedState> | null | undefined
      if (!raw || typeof raw !== 'object') return fallback
      const playlist = jsonSafe(Array.isArray(raw.playlist) ? (raw.playlist as MusicInfo[]) : [])
      const currentIndex = typeof raw.currentIndex === 'number' && raw.currentIndex < playlist.length ? raw.currentIndex : -1
      const playMode = raw.playMode === 'single' || raw.playMode === 'order' || raw.playMode === 'shuffle' || raw.playMode === 'list' ? raw.playMode : undefined
      return {
        playlist,
        currentIndex,
        quality: (raw.quality as Quality | undefined) ?? this.settings.defaultQuality,
        volume: typeof raw.volume === 'number' ? raw.volume : 1,
        mute: raw.mute === true,
        playMode,
        settings: raw.settings as PluginSettings | undefined,
      }
    } catch (err) {
      console.warn('[lxPlayback] 读取持久化状态失败:', err)
      return fallback
    }
  }

  private schedulePersist(): void {
    if (!this.storage) return
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      const payload: PersistedState = {
        playlist: this.state.playlist,
        currentIndex: this.state.currentIndex,
        quality: this.state.quality,
        volume: this.state.volume,
        mute: this.state.mute,
        playMode: this.state.playMode,
        settings: this.settings,
      }
      this.storage!.global.set(payload).catch((err) => console.warn('[lxPlayback] 持久化失败:', err))
    }, 300)
  }

  private bump(): void {
    this.state.version += 1
  }

  // ── Remote: 状态查询 ──────────────────────────────────────────────────────

  @Remote('getState')
  getState(): PlayerState {
    return jsonSafe(this.state)
  }

  @Remote('getSettings')
  getSettings(): PluginSettings {
    return { ...this.settings }
  }

  @Remote('saveSettings')
  saveSettings(partial: Partial<PluginSettings>): PluginSettings {
    this.settings = { ...this.settings, ...partial }
    if (partial.lxServerUrl !== undefined || partial.providerMode !== undefined) this.refreshProvider()
    this.onSettingsChange?.(this.settings)
    this.bump()
    this.schedulePersist()
    return { ...this.settings }
  }

  @Remote('getProviderMode')
  getProviderMode(): string {
    return this.provider.mode
  }

  // ── Remote: 播放控制 ──────────────────────────────────────────────────────

  @Remote('play')
  play(req: { index?: number }): PlayerState {
    const index = req.index
    if (index !== undefined) {
      if (index < 0 || index >= this.state.playlist.length) throw new Error(`索引越界: ${index}`)
      this.state.currentIndex = index
      this.state.progress = 0
      this.state.duration = intervalToSeconds(this.state.playlist[index]!.interval)
    }
    if (this.state.currentIndex < 0) {
      if (this.state.playlist.length === 0) throw new Error('播放列表为空')
      this.state.currentIndex = 0
    }
    this.state.current = this.state.playlist[this.state.currentIndex] ?? null
    this.state.status = 'playing'
    this.bump()
    this.schedulePersist()
    return this.state
  }

  @Remote('pause')
  pause(): PlayerState {
    this.state.status = 'paused'
    this.bump()
    return this.state
  }

  @Remote('toggle')
  toggle(): PlayerState {
    if (this.state.playlist.length === 0) throw new Error('播放列表为空')
    if (this.state.currentIndex < 0) return this.play({ index: 0 })
    this.state.status = this.state.status === 'playing' ? 'paused' : 'playing'
    this.bump()
    return this.state
  }

  /**
   * 下一首（按播放模式）：
   * - list/single：循环下一首（单曲循环下"手动切歌"同样前进，单曲重播由 client 在 ended 时本地处理）
   * - shuffle：随机选一首（列表只有 1 首时重播当前）
   * - order：顺序下一首；已在最后一首时保持当前曲目并停止
   */
  @Remote('next')
  next(): PlayerState {
    if (this.state.playlist.length === 0) throw new Error('播放列表为空')
    const len = this.state.playlist.length
    if (this.state.playMode === 'shuffle') {
      if (len === 1) return this.play({ index: 0 })
      let idx = this.state.currentIndex
      while (idx === this.state.currentIndex) idx = Math.floor(Math.random() * len)
      return this.play({ index: idx })
    }
    if (this.state.playMode === 'order') {
      const idx = this.state.currentIndex + 1
      if (idx >= len) {
        // 顺序播放到末尾：停止（保持当前曲目，进度置为末尾）
        this.state.status = 'stoped'
        this.state.progress = this.state.duration
        this.bump()
        this.schedulePersist()
        return this.state
      }
      return this.play({ index: idx })
    }
    const idx = (this.state.currentIndex + 1) % len
    return this.play({ index: idx })
  }

  /** 上一首：order 模式到列表开头后重播第一首，其余模式循环回退。 */
  @Remote('prev')
  prev(): PlayerState {
    if (this.state.playlist.length === 0) throw new Error('播放列表为空')
    const len = this.state.playlist.length
    if (this.state.playMode === 'order') {
      const idx = Math.max(0, this.state.currentIndex - 1)
      return this.play({ index: idx })
    }
    const idx = (this.state.currentIndex - 1 + len) % len
    return this.play({ index: idx })
  }

  /** 切换播放模式：list=列表循环 / single=单曲循环 / order=顺序播放 / shuffle=随机播放。 */
  @Remote('setPlayMode')
  setPlayMode(mode: PlayMode): PlayerState {
    if (mode !== 'list' && mode !== 'single' && mode !== 'order' && mode !== 'shuffle') {
      throw new Error(`未知播放模式: ${String(mode)}`)
    }
    this.state.playMode = mode
    this.bump()
    this.schedulePersist()
    return this.state
  }

  @Remote('seek')
  seek(seconds: number): void {
    this.state.progress = Math.max(0, seconds)
    this.bump()
  }

  @Remote('setVolume')
  setVolume(volume: number): PlayerState {
    this.state.volume = Math.min(1, Math.max(0, volume))
    this.bump()
    this.schedulePersist()
    return this.state
  }

  @Remote('setMute')
  setMute(mute: boolean): PlayerState {
    this.state.mute = mute
    this.bump()
    this.schedulePersist()
    return this.state
  }

  @Remote('setQuality')
  setQuality(quality: Quality): PlayerState {
    this.state.quality = quality
    this.bump()
    this.schedulePersist()
    return this.state
  }

  /** client 上报播放进度/状态（节流由 client 侧做；不 bump 版本，避免轮询抖动）。 */
  @Remote('reportProgress')
  reportProgress(p: { progress: number; duration: number; status: PlaybackStatus }): void {
    this.state.progress = typeof p.progress === 'number' ? p.progress : this.state.progress
    this.state.duration = typeof p.duration === 'number' && p.duration > 0 ? p.duration : this.state.duration
    if (p.status) this.state.status = p.status
  }

  // ── Remote: 播放列表管理 ──────────────────────────────────────────────────

  @Remote('addMusic')
  addMusic(musics: MusicInfo[], position: AddPosition): PlayerState {
    // 注意：SRC 反射要求参数为纯标识符（无默认值），默认值在方法体内处理
    const pos = position ?? 'tail'
    if (!Array.isArray(musics) || musics.length === 0) throw new Error('没有可添加的歌曲')
    const playlist = [...this.state.playlist]
    if (pos === 'next' && this.state.currentIndex >= 0) {
      // 插入到当前歌曲之后（"下一首播放"），不改变当前播放位置
      playlist.splice(this.state.currentIndex + 1, 0, ...musics)
    } else {
      playlist.push(...musics)
    }
    this.state.playlist = playlist
    if (this.state.currentIndex < 0) {
      this.state.currentIndex = playlist.indexOf(musics[0]!)
      this.state.current = playlist[this.state.currentIndex] ?? null
      this.state.status = 'paused'
    }
    this.bump()
    this.schedulePersist()
    return this.state
  }

  @Remote('removeMusic')
  removeMusic(id: string): PlayerState {
    const idx = this.state.playlist.findIndex((m) => m.id === id)
    if (idx < 0) return this.state
    const playlist = this.state.playlist.filter((m) => m.id !== id)
    this.state.playlist = playlist
    if (idx < this.state.currentIndex) this.state.currentIndex -= 1
    else if (idx === this.state.currentIndex) {
      this.state.currentIndex = playlist.length > 0 ? Math.min(idx, playlist.length - 1) : -1
      this.state.current = this.state.currentIndex >= 0 ? playlist[this.state.currentIndex]! : null
      if (this.state.currentIndex < 0) this.state.status = 'stoped'
    }
    this.bump()
    this.schedulePersist()
    return this.state
  }

  @Remote('clearList')
  clearList(): PlayerState {
    this.state.playlist = []
    this.state.currentIndex = -1
    this.state.current = null
    this.state.status = 'stoped'
    this.state.progress = 0
    this.state.duration = 0
    this.bump()
    this.schedulePersist()
    return this.state
  }

  @Remote('reorderList')
  reorderList(ids: string[]): PlayerState {
    const byId = new Map(this.state.playlist.map((m) => [m.id, m]))
    const next: MusicInfo[] = []
    for (const id of ids) {
      const m = byId.get(id)
      if (m) {
        next.push(m)
        byId.delete(id)
      }
    }
    for (const m of byId.values()) next.push(m)
    const current = this.state.current
    this.state.playlist = next
    this.state.currentIndex = current ? next.findIndex((m) => m.id === current.id) : -1
    this.state.current = this.state.currentIndex >= 0 ? next[this.state.currentIndex]! : null
    this.bump()
    this.schedulePersist()
    return this.state
  }

  @Remote('exportList')
  exportList(): string {
    if (this.state.playlist.length === 0) return '（播放列表为空）'
    const lines = this.state.playlist.map((m, i) => {
      const marker = i === this.state.currentIndex ? '▶ ' : ''
      return `${marker}${i + 1}. ${m.name} - ${m.singer} [${m.source}] ${m.interval ?? ''}`
    })
    return `LX Music 播放列表（${this.state.playlist.length} 首）\n${lines.join('\n')}`
  }

  // ── Remote: 搜索与直链 ────────────────────────────────────────────────────

  @Remote('search')
  async search(req: SearchRequest): Promise<SearchOutcome> {
    const sources = req.sources && req.sources.length > 0 ? req.sources : this.settings.platformPriority
    return jsonSafe(await this.provider.search({
      query: req.query,
      sources,
      singer: req.singer,
      type: req.type,
      limit: req.limit ?? 20,
    }))
  }

  /** 直链解析（带音质降级链 + 平台回退）。 */
  @Remote('resolveUrl')
  async resolveUrl(req: { music: MusicInfo; quality?: Quality }): Promise<MusicUrlResult> {
    const music = req.music
    const explicitQuality = req.quality
    const cacheKey = `${music.id}|${explicitQuality ?? 'auto'}`
    const cached = this.urlCache.get(cacheKey)
    if (cached) return jsonSafe(cached)

    const errors: string[] = []
    const qualityChain = this.qualityChainFor(music, explicitQuality)
    const strategies: Array<'next-quality' | 'next-platform'> =
      this.settings.fallbackStrategy === 'both'
        ? ['next-quality', 'next-platform']
        : [this.settings.fallbackStrategy]

    for (const quality of qualityChain) {
      try {
        const result = jsonSafe(await this.provider.resolveUrl(music, quality))
        this.urlCache.set(cacheKey, result)
        return result
      } catch (err) {
        errors.push(`${quality}: ${err instanceof Error ? err.message : String(err)}`)
        if (!strategies.includes('next-quality')) break
      }
    }

    // 平台回退：用歌名+歌手在后续平台重新定位同曲。
    // 回退顺序 = 该平台的自定义优先级（perSourcePlatformPriority[当前平台]）或全局 platformPriority。
    if (strategies.includes('next-platform') && music.singer) {
      const custom = this.settings.perSourcePlatformPriority[music.source]
      const base = custom && custom.length > 0 ? custom : this.settings.platformPriority
      const rest = base.filter((s) => s !== music.source)
      for (const source of rest.slice(0, 2)) {
        try {
          const outcome = await this.provider.search({ query: `${music.name} ${music.singer}`, sources: [source], limit: 3 })
          const candidate = outcome.results.find((m) => m.name === music.name && m.singer === music.singer) ?? outcome.results[0]
          if (candidate) {
            const quality = this.qualityChainFor(candidate, explicitQuality)[0]!
            const result = jsonSafe(await this.provider.resolveUrl(candidate, quality))
            this.urlCache.set(cacheKey, result)
            return result
          }
        } catch (err) {
          errors.push(`${source}: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    const recent = getSandboxRequestLog()
      .slice(-5)
      .map((r) => `${r.statusCode ?? 'ERR'}:${r.error ?? ''}${r.url}(${r.ms}ms)`)
    const message = `直链解析失败（${errors.join('；') || '无可用策略'}）${recent.length > 0 ? ` | 最近请求: ${recent.join('; ')}` : ''}`
    const err = new Error(message) as Error & { attempts?: unknown[] }
    err.attempts = errors.map((e) => ({ name: 'resolve', status: 'fail', message: e }))
    console.error(`[lx-music] resolveUrl 全部失败: ${message}`)
    throw err
  }

  private qualityChainFor(music: MusicInfo, explicit?: Quality): Quality[] {
    const chain: Quality[] = []
    const push = (q: Quality) => {
      if (!chain.includes(q)) chain.push(q)
    }
    if (explicit) push(explicit)
    push(pickQuality(music, this.settings, explicit))
    for (const q of [...this.settings.qualityFallbackChain].sort((a, b) => rankQuality(b) - rankQuality(a))) push(q)
    // 兜底补全常见音质
    for (const q of ['flac', '320k', '128k'] as Quality[]) push(q)
    return chain
  }

  // ── Remote: 音源管理（设置窗口） ──────────────────────────────────────────

  @Remote('listSources')
  async listSources(): Promise<SourceEntry[]> {
    return jsonSafe(await this.provider.listSources())
  }

  @Remote('validateSource')
  async validateSource(script: string): Promise<unknown> {
    return jsonSafe(await this.provider.validateSource(script))
  }

  @Remote('uploadSource')
  async uploadSource(filename: string, content: string): Promise<{ success: boolean; id?: string; error?: string }> {
    return jsonSafe(await this.provider.uploadSource(filename, content))
  }

  @Remote('importSource')
  async importSource(req: { url: string; filename?: string }): Promise<{ success: boolean; id?: string; error?: string }> {
    return jsonSafe(await this.provider.importSource(req.url, req.filename))
  }

  @Remote('toggleSource')
  async toggleSource(id: string, enabled: boolean): Promise<{ success: boolean; enabled?: boolean; error?: string }> {
    return jsonSafe(await this.provider.toggleSource(id, enabled))
  }

  @Remote('deleteSource')
  async deleteSource(id: string): Promise<{ success: boolean; error?: string }> {
    return jsonSafe(await this.provider.deleteSource(id))
  }

  @Remote('reorderSources')
  async reorderSources(ids: string[]): Promise<{ success: boolean; error?: string }> {
    return jsonSafe(await this.provider.reorderSources(ids))
  }

  // ── 日志（供 tools 与设置窗口） ───────────────────────────────────────────

  @Remote('getLogs')
  getLogs(req: { limit?: number }): PlayLogEntry[] {
    const limit = req.limit ?? 50
    if (!this.storage) return []
    const logs: PlayLogEntry[] = []
    for (const [, value] of this.storage.table('logs').entries()) {
      logs.push(value as PlayLogEntry)
    }
    logs.sort((a, b) => (a.time < b.time ? 1 : -1))
    return jsonSafe(logs.slice(0, limit))
  }

  log(entry: PlayLogEntry): void {
    this.onLog?.(entry)
  }
}

/** 供 index.ts 使用的存储适配（把 storage domain 收敛为 StorageFace）。 */
export function adaptDomain(domain: Domain<DomainSpec>): StorageFace {
  return {
    global: {
      get: () => (domain.global as { get(): unknown }).get(),
      set: (value) => (domain.global as { set(v: unknown): Promise<void> }).set(value),
    },
    table: (name: string) => {
      const table = (domain as unknown as { table(n: string): { get(k: string): unknown; put(k: string, v: unknown): Promise<void>; entries(): IterableIterator<[string, unknown]>; delete(k: string): Promise<boolean> } }).table(name)
      return table
    },
  }
}
