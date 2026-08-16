// Client 播放引擎与全局 store。
// - 轮询 host PlaybackService（getState）并 diff 应用：歌曲变化 → 解析直链并播放
// - HTML5 Audio 执行端：进度上报（节流）、播放结束自动下一首、错误降级
// - 窗口开关状态、设置与音源快照

import type {
  AddPosition,
  MusicInfo,
  PlayMode,
  PlayerState,
  PluginSettings,
  Quality,
  SearchOutcome,
  SearchRequest,
  SourceEntry,
} from '../shared/types'

/** client 侧 remote 接口（host PlaybackService 的镜像）。
 * 注意：wire 参数必须全量传递（DSH gateway 拒绝缺失参数），
 * 可选值一律放进必填对象参数内（play({index}) / resolveUrl({music, quality?}) 等）。 */
export interface LxRemote {
  getState(): Promise<PlayerState>
  getSettings(): Promise<PluginSettings>
  saveSettings(partial: Partial<PluginSettings>): Promise<PluginSettings>
  play(req: { index?: number }): Promise<PlayerState>
  pause(): Promise<PlayerState>
  toggle(): Promise<PlayerState>
  next(): Promise<PlayerState>
  prev(): Promise<PlayerState>
  seek(seconds: number): Promise<void>
  setVolume(volume: number): Promise<PlayerState>
  setMute(mute: boolean): Promise<PlayerState>
  setQuality(quality: Quality): Promise<PlayerState>
  setPlayMode(mode: PlayMode): Promise<PlayerState>
  reportProgress(p: { progress: number; duration: number; status: string }): Promise<void>
  addMusic(musics: MusicInfo[], position: AddPosition): Promise<PlayerState>
  removeMusic(id: string): Promise<PlayerState>
  clearList(): Promise<PlayerState>
  reorderList(ids: string[]): Promise<PlayerState>
  exportList(): Promise<string>
  search(req: SearchRequest): Promise<SearchOutcome>
  resolveUrl(req: { music: MusicInfo; quality?: Quality }): Promise<{ url: string; type: Quality; sourceName?: string }>
  listSources(): Promise<SourceEntry[]>
  validateSource(script: string): Promise<{ valid: boolean; error?: string; sources?: string[] }>
  uploadSource(filename: string, content: string): Promise<{ success: boolean; id?: string; error?: string }>
  importSource(req: { url: string; filename?: string }): Promise<{ success: boolean; id?: string; error?: string }>
  toggleSource(id: string, enabled: boolean): Promise<{ success: boolean; enabled?: boolean; error?: string }>
  deleteSource(id: string): Promise<{ success: boolean; error?: string }>
  reorderSources(ids: string[]): Promise<{ success: boolean; error?: string }>
  getLogs(limit?: number): Promise<unknown[]>
}

export interface StoreSnapshot {
  state: PlayerState | null
  settings: PluginSettings | null
  sources: SourceEntry[]
  mainOpen: boolean
  settingsOpen: boolean
  loading: boolean
  error: string | null
  connected: boolean
}

const POLL_MS = 500
const REPORT_MS = 1000

export class LxStore {
  private remote: LxRemote
  private snapshot: StoreSnapshot = {
    state: null,
    settings: null,
    sources: [],
    mainOpen: false,
    settingsOpen: false,
    loading: false,
    error: null,
    connected: false,
  }
  private listeners = new Set<() => void>()
  private audio: HTMLAudioElement | null = null
  private lastVersion = -1
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private lastReport = 0
  private loadingTrack = false
  private started = false

  constructor(remote: LxRemote) {
    this.remote = remote
  }

  // ── 订阅接口 ──────────────────────────────────────────────────────────────

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  getSnapshot = (): StoreSnapshot => this.snapshot

  private emit(): void {
    for (const fn of this.listeners) {
      try {
        fn()
      } catch {
        // 忽略单个监听器错误
      }
    }
  }

  private patch(p: Partial<StoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...p }
    this.emit()
  }

  // ── 生命周期 ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.started) return
    this.started = true
    this.audio = new Audio()
    this.audio.preload = 'auto'
    this.audio.addEventListener('timeupdate', this.onTimeUpdate)
    this.audio.addEventListener('ended', this.onEnded)
    this.audio.addEventListener('error', this.onAudioError)
    this.audio.addEventListener('play', this.onPlay)
    this.audio.addEventListener('pause', this.onPause)
    void this.refreshAll()
    this.pollTimer = setInterval(() => void this.sync(), POLL_MS)
    this.reportTimer = setInterval(() => this.reportProgress(), REPORT_MS)
  }

  dispose(): void {
    if (!this.started) return
    this.started = false
    if (this.pollTimer) clearInterval(this.pollTimer)
    if (this.reportTimer) clearInterval(this.reportTimer)
    if (this.audio) {
      this.audio.pause()
      this.audio.removeEventListener('timeupdate', this.onTimeUpdate)
      this.audio.removeEventListener('ended', this.onEnded)
      this.audio.removeEventListener('error', this.onAudioError)
      this.audio.removeEventListener('play', this.onPlay)
      this.audio.removeEventListener('pause', this.onPause)
    }
  }

  // ── 同步 ──────────────────────────────────────────────────────────────────

  async refreshAll(): Promise<void> {
    try {
      const [state, settings, sources] = await Promise.all([
        this.remote.getState(),
        this.remote.getSettings(),
        this.remote.listSources(),
      ])
      const trackChanged = state.current?.id !== this.snapshot.state?.current?.id
      const versionChanged = state.version !== this.lastVersion
      this.patch({ state, settings, sources, connected: true, error: null })
      this.lastVersion = state.version
      if (versionChanged && trackChanged) {
        void this.loadTrack(state)
      } else if (versionChanged) {
        this.applyStatus(state.status)
      }
    } catch (err) {
      this.patch({ connected: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  private async sync(): Promise<void> {
    try {
      const state = await this.remote.getState()
      const trackChanged = state.current?.id !== this.snapshot.state?.current?.id
      const versionChanged = state.version !== this.lastVersion
      if (!versionChanged) return
      this.lastVersion = state.version
      this.patch({ state, connected: true, error: null })
      if (trackChanged) {
        void this.loadTrack(state)
      } else {
        this.applyStatus(state.status)
        this.emit()
      }
    } catch {
      // 轮询失败静默，避免日志刷屏
    }
  }

  /** 加载当前曲目并（按状态）播放。 */
  private async loadTrack(state: PlayerState): Promise<void> {
    const music = state.current
    if (!music) return
    if (this.loadingTrack) return
    this.loadingTrack = true
    this.patch({ loading: true, error: null })
    try {
      const resolved = await this.remote.resolveUrl({ music, quality: state.quality })
      if (!this.audio) return
      this.audio.src = resolved.url
      this.audio.volume = state.mute ? 0 : state.volume
      if (state.status === 'playing') {
        await this.audio.play().catch(() => undefined)
      }
      this.patch({ loading: false })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 直链解析失败：完整错误打到浏览器 console（含各音源脚本错误与最近 HTTP 状态码），便于诊断
      console.error('[lx-music] 直链解析失败:', message, err instanceof Error ? err : undefined)
      this.patch({ loading: false, error: message })
      // 自动切下一首（跳过坏歌）
      void this.remote.next().catch(() => undefined)
    } finally {
      this.loadingTrack = false
    }
  }

  private applyStatus(status: string): void {
    if (!this.audio) return
    if (status === 'playing' && this.audio.paused && this.audio.src) {
      void this.audio.play().catch(() => undefined)
    } else if (status === 'paused' && !this.audio.paused) {
      this.audio.pause()
    }
  }

  // ── 音频事件 ──────────────────────────────────────────────────────────────

  private onTimeUpdate = (): void => {
    if (!this.audio) return
    // 本地乐观更新 UI（进度条平滑）
    const st = this.snapshot.state
    if (st && st.current) {
      this.patch({
        state: {
          ...st,
          progress: this.audio.currentTime,
          duration: this.audio.duration || st.duration,
        },
      })
    }
  }

  private onPlay = (): void => {
    if (!this.audio) return
    const st = this.snapshot.state
    if (st && st.status !== 'playing') {
      this.patch({ state: { ...st, status: 'playing' } })
      void this.remote.reportProgress({ progress: this.audio.currentTime, duration: this.audio.duration || st.duration, status: 'playing' })
    }
  }

  private onPause = (): void => {
    if (!this.audio) return
    const st = this.snapshot.state
    if (st && st.status === 'playing') {
      this.patch({ state: { ...st, status: 'paused' } })
      void this.remote.reportProgress({ progress: this.audio.currentTime, duration: this.audio.duration || st.duration, status: 'paused' })
    }
  }

  private onEnded = (): void => {
    const st = this.snapshot.state
    if (st?.playMode === 'single' && this.audio && st.current) {
      // 单曲循环：当前曲目播完本地重播（不切歌，进度/状态经 reportProgress 上报）
      this.audio.currentTime = 0
      void this.audio.play().catch(() => undefined)
      void this.remote.reportProgress({ progress: 0, duration: st.duration, status: 'playing' })
      return
    }
    // 其余模式：交给 host 按播放模式决定下一首（列表循环/随机/顺序）
    void this.remote.next().catch(() => undefined)
  }

  private onAudioError = (): void => {
    const st = this.snapshot.state
    if (st?.current) {
      this.patch({ error: '音频播放失败，正在尝试下一首…' })
      void this.remote.reportProgress({ progress: 0, duration: st.duration, status: 'error' })
    }
  }

  private reportProgress(): void {
    const now = Date.now()
    if (now - this.lastReport < REPORT_MS) return
    this.lastReport = now
    const st = this.snapshot.state
    if (!st?.current) return
    void this.remote.reportProgress({
      progress: this.audio?.currentTime ?? st.progress,
      duration: this.audio?.duration || st.duration,
      status: this.audio && !this.audio.paused ? 'playing' : st.status,
    })
  }

  // ── 用户操作（直接调 remote，返回后本地应用） ─────────────────────────────

  async togglePlay(): Promise<void> {
    try {
      const st = await this.remote.toggle()
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async next(): Promise<void> {
    try {
      const st = await this.remote.next()
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async prev(): Promise<void> {
    try {
      const st = await this.remote.prev()
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async playAt(index: number): Promise<void> {
    try {
      const st = await this.remote.play({ index })
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async seek(seconds: number): Promise<void> {
    if (this.audio) {
      this.audio.currentTime = seconds
      const st = this.snapshot.state
      if (st) this.patch({ state: { ...st, progress: seconds } })
    }
    await this.remote.seek(seconds).catch(() => undefined)
  }

  /** 拖动进度条时的本地乐观更新（不触发 remote）。 */
  updateLocalProgress(seconds: number): void {
    const st = this.snapshot.state
    if (st) this.patch({ state: { ...st, progress: seconds } })
  }

  async addMusic(musics: MusicInfo[], position: AddPosition): Promise<void> {
    try {
      const st = await this.remote.addMusic(musics, position)
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async removeMusic(id: string): Promise<void> {
    try {
      const st = await this.remote.removeMusic(id)
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async clearList(): Promise<void> {
    try {
      const st = await this.remote.clearList()
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async reorderList(ids: string[]): Promise<void> {
    try {
      const st = await this.remote.reorderList(ids)
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async exportList(): Promise<string> {
    return this.remote.exportList()
  }

  async setVolume(volume: number): Promise<void> {
    if (this.audio) this.audio.volume = volume
    try {
      const st = await this.remote.setVolume(volume)
      this.applyState(st)
    } catch {
      // 忽略
    }
  }

  async setQuality(quality: Quality): Promise<void> {
    try {
      const st = await this.remote.setQuality(quality)
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async setPlayMode(mode: PlayMode): Promise<void> {
    try {
      const st = await this.remote.setPlayMode(mode)
      this.applyState(st)
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async search(req: SearchRequest): Promise<SearchOutcome> {
    return this.remote.search(req)
  }

  async saveSettings(partial: Partial<PluginSettings>): Promise<PluginSettings> {
    const settings = await this.remote.saveSettings(partial)
    this.patch({ settings })
    return settings
  }

  async refreshSources(): Promise<void> {
    try {
      const sources = await this.remote.listSources()
      this.patch({ sources })
    } catch (err) {
      this.patch({ error: err instanceof Error ? err.message : String(err) })
    }
  }

  async validateSource(script: string): Promise<{ valid: boolean; error?: string; sources?: string[] }> {
    return this.remote.validateSource(script)
  }

  async uploadSource(filename: string, content: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const result = await this.remote.uploadSource(filename, content)
    if (result.success) await this.refreshSources()
    return result
  }

  async importSource(url: string, filename?: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const result = await this.remote.importSource({ url, filename })
    if (result.success) await this.refreshSources()
    return result
  }

  async toggleSource(id: string, enabled: boolean): Promise<{ success: boolean; enabled?: boolean; error?: string }> {
    const result = await this.remote.toggleSource(id, enabled)
    if (result.success) await this.refreshSources()
    return result
  }

  async deleteSource(id: string): Promise<{ success: boolean; error?: string }> {
    const result = await this.remote.deleteSource(id)
    if (result.success) await this.refreshSources()
    return result
  }

  async reorderSources(ids: string[]): Promise<{ success: boolean; error?: string }> {
    const result = await this.remote.reorderSources(ids)
    if (result.success) await this.refreshSources()
    return result
  }

  // ── UI 状态 ───────────────────────────────────────────────────────────────

  openMain(): void {
    this.patch({ mainOpen: true })
    void this.refreshAll()
  }

  closeMain(): void {
    this.patch({ mainOpen: false })
  }

  openSettings(): void {
    this.patch({ settingsOpen: true })
    void this.refreshAll()
  }

  closeSettings(): void {
    this.patch({ settingsOpen: false })
  }

  clearError(): void {
    this.patch({ error: null })
  }

  private applyState(st: PlayerState): void {
    const trackChanged = st.current?.id !== this.snapshot.state?.current?.id
    this.lastVersion = st.version
    this.patch({ state: st, connected: true, error: null })
    if (trackChanged) {
      void this.loadTrack(st)
    } else {
      this.applyStatus(st.status)
    }
  }
}
