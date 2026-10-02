// Client 播放引擎与全局 store。
// - 轮询 host PlaybackService（getState）并 diff 应用：歌曲变化 → 解析直链并播放
// - HTML5 Audio 执行端：进度上报（节流）、播放结束自动下一首、错误降级
// - 窗口开关状态、设置与音源快照

import type {
  AddPosition,
  MemoryConfigView,
  MusicInfo,
  PlayMode,
  PlayerState,
  PluginSettings,
  Quality,
  SearchOutcome,
  SearchRequest,
  SourceEntry,
  TasteActionInput,
  TasteActionResult,
  TasteEventRow,
  TasteProfileView,
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
  // 音乐画像（1.2.0）
  getTasteProfile(req: { view?: string; limit?: number; mood?: string }): Promise<TasteProfileView>
  getTasteEvents(req: { limit?: number }): Promise<TasteEventRow[]>
  tasteAction(req: TasteActionInput): Promise<TasteActionResult>
  setMemoryConfig(req: { patch: Record<string, unknown> }): Promise<MemoryConfigView>
}

export interface StoreSnapshot {
  state: PlayerState | null
  settings: PluginSettings | null
  sources: SourceEntry[]
  mainOpen: boolean
  settingsOpen: boolean
  /** 「我的口味」窗口（首启引导也复用它）。 */
  tasteOpen: boolean
  taste: TasteProfileView | null
  tasteEvents: TasteEventRow[]
  /** 用户主动选择的标签页（引导 vs 口味管理）。 */
  tasteOnboarding: boolean
  tasteBusy: boolean
  tasteNotice: string | null
  loading: boolean
  error: string | null
  connected: boolean
}

const POLL_MS = 500
const REPORT_MS = 1000

/**
 * 曲目身份键。**不能只用 `id`**：不同平台的同一首歌可能拿到相同 id，而音质变化
 * （320k → flac）也必须是"需要重新解析直链"的变化。
 * 同一个键 = 同一份流，切歌/换音质都会得到不同的键。
 */
function trackKey(music: MusicInfo | null | undefined, quality: string): string {
  if (!music) return ''
  return `${music.source}|${music.id}|${quality}`
}

export class LxStore {
  private remote: LxRemote
  private snapshot: StoreSnapshot = {
    state: null,
    settings: null,
    sources: [],
    mainOpen: false,
    settingsOpen: false,
    tasteOpen: false,
    taste: null,
    tasteEvents: [],
    tasteOnboarding: false,
    tasteBusy: false,
    tasteNotice: null,
    loading: false,
    error: null,
    connected: false,
  }
  /** 首启引导是否已经弹过（每个客户端会话只自动弹一次，避免每次刷新都打扰）。 */
  private tastePrompted = false
  private listeners = new Set<() => void>()
  private audio: HTMLAudioElement | null = null
  private lastVersion = -1
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private reportTimer: ReturnType<typeof setInterval> | null = null
  private lastReport = 0
  /**
   * 直链解析的**代数**：每次发起解析就 +1，异步结果回来时用它判断自己是否已经过期。
   *
   * 这是"我明明换了歌，播的还是上一首"的核心防线。旧实现用一个 `loadingTrack` 布尔把
   * **新的**加载请求直接丢掉（`if (this.loadingTrack) return`），解析返回后又无条件写
   * `audio.src` —— 于是新歌的加载被丢弃、旧歌的流被贴上去；又因为状态里已经是新歌，
   * 下一轮轮询看不出"曲目变了"，就**永久卡在**"UI 是新歌、声音是旧歌"。
   *
   * 为什么用"代数"而不是"用当前曲目键去比对"：曲目键在**发起加载时就确定了**，
   * 而写入 `audio.src` 要等 await 回来。若拿 `loadedKey`（=已写入的流）判断，
   * 会出现"新目标已开始解析、但还没写入"的窗口：此时被抢占的旧加载回来会误判成
   * "当前曲目还没加载"并再解析一次（同一首歌解析两遍，两次结果还会互相覆盖 —— 
   * 实测表现为偶发多打一次音源脚本，最坏情况下第二次失败会把好好的那首跳掉）。
   * 代数比较没有这个窗口：任何一次异步结果，只要不是最新那次，就一律丢弃。
   */
  private loadGen = 0
  /** 最新一次解析的 promise（`void this.loadTrack()` 的产物，供测试与错误处理观察）。 */
  private pending: Promise<void> | null = null
  /** 最近一次**成功写入** `audio.src` 的曲目键（同一份流不重复解析：paused→playing 不重解析）。 */
  private loadedKey = ''
  /** 最近一次**解析失败**的曲目键：同一首不再自动重试，避免每轮 500ms 轮询都打一遍音源脚本。 */
  private failedKey = ''
  /** 每个曲目键已发生的音频错误次数（用于"重解析一次再不成功就跳歌"）。 */
  private errorRetry = new Map<string, number>()
  /** 错误重试表的容量上限（超过按最旧淘汰，避免长时间会话无界增长）。 */
  private static readonly ERROR_RETRY_MAX = 200
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
      const versionChanged = state.version !== this.lastVersion
      this.patch({ state, settings, sources, connected: true, error: null })
      this.lastVersion = state.version
      if (versionChanged) this.syncState(state)
      void this.refreshTaste()
    } catch (err) {
      this.patch({ connected: false, error: err instanceof Error ? err.message : String(err) })
    }
  }

  /**
   * 拉取画像并决定是否自动弹首启引导。
   *
   * 自动弹的条件：画像开启 + 还没引导过 + 不在"稍后再说"的静默期 + 本会话还没弹过。
   * 只在 refreshAll() 里调用（低频），不进轮询，避免每次同步都打一次远端。
   */
  async refreshTaste(): Promise<void> {
    try {
      const taste = await this.remote.getTasteProfile({ limit: 20 })
      this.patch({ taste })
      if (!this.tastePrompted && taste.enabled && !taste.onboarded && !taste.snoozed) {
        this.tastePrompted = true
        this.patch({ tasteOpen: true, tasteOnboarding: true })
      }
    } catch {
      // 画像不可用（旧版 host / storage 未就绪）时静默忽略：不影响播放主流程
    }
  }

  private async sync(): Promise<void> {
    try {
      const state = await this.remote.getState()
      const versionChanged = state.version !== this.lastVersion
      if (!versionChanged) return
      this.lastVersion = state.version
      this.patch({ state, connected: true, error: null })
      this.syncState(state)
    } catch {
      // 轮询失败静默，避免日志刷屏
    }
  }

  /**
   * 解析当前曲目的直链并写入 `audio`。
   *
   * 三条不变量（每条都对应一个真实踩过的坑）：
   *   1. **只有最新一次解析能落地**：结果回来先比 `loadGen`，不是最新就整段丢弃 ——
   *      这杜绝了"换了歌，播的还是上一首"；
   *   2. **过期请求不产生副作用**：过期结果既不写 `audio.src`、也不报错、也不跳歌
   *      （旧实现里，被抢占的那次失败会把新歌误判成坏歌直接 `next()`）；
   *   3. **失败要记账**：把曲目键记进 `failedKey`，避免每轮 500ms 轮询都重试同一首。
   *
   * 这个方法**可以并发重入**：`loadGen` 保证后发者胜出，先发者的结果被丢弃。
   */
  private async loadTrack(state: PlayerState): Promise<void> {
    const requested = trackKey(state.current, state.quality)
    const music = state.current
    this.loadGen += 1
    const gen = this.loadGen
    // ⚠️ 必须 await **自己这一次**的 promise，不能 await `this.pending`：
    // 并发切歌时 `this.pending` 早已被后一次加载覆盖，await 它会变成"等最新那次"——
    // 于是先发起的那次永远不返回（实测把测试套件整个挂死）。
    const run = this.runLoad(gen, requested, state, music)
    this.pending = run
    await run
  }

  private async runLoad(gen: number, requested: string, state: PlayerState, music: MusicInfo | null): Promise<void> {
    if (!music) return
    this.patch({ loading: true, error: null })
    try {
      const resolved = await this.remote.resolveUrl({ music, quality: state.quality })
      // 不变量 1/2：已经被更新的加载取代 → 丢弃（不写 src、不动状态）
      if (gen !== this.loadGen) return
      if (!this.audio) return
      this.loadedKey = requested
      this.failedKey = ''
      // 这份流已经拿到并落地 → 清掉该曲目的错误重试计数，
      // 否则"一首歌曾经失败过一次"会永久占用它的重试预算（再次播放时直接跳歌）。
      this.errorRetry.delete(requested)
      this.audio.src = resolved.url
      this.audio.volume = state.mute ? 0 : state.volume
      if (state.status === 'playing') {
        await this.audio.play().catch(() => undefined)
      }
      this.patch({ loading: false })
    } catch (err) {
      // 过期请求的失败与当前播放无关，必须完全静默（旧实现会因此跳掉正在播的歌）
      if (gen !== this.loadGen) return
      const message = err instanceof Error ? err.message : String(err)
      // 直链解析失败：完整错误打到浏览器 console（含各音源脚本错误与最近 HTTP 状态码），便于诊断
      console.error('[lx-music] 直链解析失败:', message, err instanceof Error ? err : undefined)
      this.loadedKey = requested
      this.failedKey = requested
      this.patch({ loading: false, error: message })
      // 自动切下一首（跳过坏歌）
      void this.remote.next().catch(() => undefined)
    }
  }

  /** 状态同步入口：需要"换到另一份流"才重新解析直链，否则只跟随播放/暂停。 */
  private syncState(state: PlayerState): void {
    const requested = trackKey(state.current, state.quality)
    // 同一份流不重复解析；刚失败过的那首也不自动重试（等 host 切歌或用户再点一次）
    const needsStream = requested !== '' && requested !== this.loadedKey && requested !== this.failedKey
    if (needsStream) {
      void this.loadTrack(state)
      return
    }
    this.applyStatus(state.status)
  }

  /**
   * 等当前在飞的直链解析收尾（**测试与诊断用**，生产代码不依赖它）。
   *
   * 存在的理由：`loadTrack` 在生产里是 `void` 调起的，外部没有"已稳定"的信号，
   * 于是测试只能靠 `setTimeout` 猜 tick 数 —— 那是构造性竞态（第一版测试就是这么假失败的）。
   *
   * ⚠️ 有界：最多等 10 轮。**绝不能**写成"`await this.pending` 直到它变 null"——
   * 若某次解析的 promise 永不 settle（取消、脚本卡死），那种写法会把调用方一起挂死，
   * 而不是让测试失败。（这正是第一版实现把整条测试流水线挂住的原因。）
   */
  async settleLoaded(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      const current = this.pending
      if (current === null) return
      await Promise.race([current.catch(() => undefined), new Promise((r) => setTimeout(r, 50))])
      if (this.pending === current) return
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

  /**
   * 音频元素报错：直链多半已经失效（签名过期/防盗链/网络抖动）。
   *
   * 旧实现只贴一条提示并且**什么都不做**，于是"拉到坏流"就等于卡住——用户看到的是
   * "这首歌播不出来，也不自动往下走"。现在按曲目键处理：同一首最多重解析一次，再失败就跳下一首。
   */
  private onAudioError = (): void => {
    const st = this.snapshot.state
    if (!st?.current) return
    const key = trackKey(st.current, st.quality)
    const attempt = (this.errorRetry.get(key) ?? 0) + 1
    this.errorRetry.set(key, attempt)
    while (this.errorRetry.size > LxStore.ERROR_RETRY_MAX) {
      const oldest = this.errorRetry.keys().next()
      if (oldest.done === true) break
      this.errorRetry.delete(oldest.value)
    }
    void this.remote.reportProgress({ progress: 0, duration: st.duration, status: 'error' })
    if (attempt === 1 && this.pending === null) {
      // 让 syncState 认为"这份流还没就绪" → 重新解析一次（新直链通常就正常了）。
      // 同时清掉 failedKey：这是一次**用户可感知的播放失败**，值得重试一次；
      // 而 syncState 里对 failedKey 的去重是为了挡住"解析失败后每 500ms 重试"。
      this.failedKey = ''
      this.patch({ error: '音频流失效，正在重新解析…' })
      this.syncState(st)
      return
    }
    this.patch({ error: '音频播放失败，正在尝试下一首…' })
    void this.remote.next().catch(() => undefined)
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

  // ── 「我的口味」（含首启引导） ───────────────────────────────────────────

  openTaste(options: { onboarding?: boolean } = {}): void {
    // 未开启实验性画像时不给入口：连内部调用（含自动引导）也一并挡掉，
    // 避免出现"关着却有窗口"的矛盾状态。开启入口只在设置窗口的「实验性」页。
    if (this.snapshot.taste?.enabled !== true) return
    this.patch({ tasteOpen: true, tasteOnboarding: options.onboarding ?? false, tasteNotice: null })
    void this.refreshTaste()
    void this.refreshTasteEvents()
  }

  closeTaste(): void {
    this.patch({ tasteOpen: false })
  }

  async refreshTasteEvents(limit = 20): Promise<void> {
    try {
      const tasteEvents = await this.remote.getTasteEvents({ limit })
      this.patch({ tasteEvents })
    } catch {
      // 画像不可用时静默
    }
  }

  /** 画像写操作（like/dislike/forget/note/clear/onboard/snooze）。 */
  async tasteAction(req: TasteActionInput): Promise<TasteActionResult> {
    this.patch({ tasteBusy: true, tasteNotice: null })
    try {
      const result = await this.remote.tasteAction(req)
      await this.refreshTaste()
      await this.refreshTasteEvents()
      this.patch({ tasteBusy: false, tasteNotice: result.message })
      return result
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.patch({ tasteBusy: false, tasteNotice: `失败：${message}` })
      return { ok: false, message }
    }
  }

  /** 改画像配置（开关/保留期/预算档位/半衰期）。 */
  async setMemoryConfig(patch: Record<string, unknown>): Promise<MemoryConfigView | null> {
    this.patch({ tasteBusy: true, tasteNotice: null })
    try {
      const config = await this.remote.setMemoryConfig({ patch })
      await this.refreshTaste()
      this.patch({ tasteBusy: false, tasteNotice: '设置已保存' })
      return config
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.patch({ tasteBusy: false, tasteNotice: `保存失败：${message}` })
      return null
    }
  }

  clearError(): void {
    this.patch({ error: null })
  }

  private applyState(st: PlayerState): void {
    this.lastVersion = st.version
    this.patch({ state: st, connected: true, error: null })
    this.syncState(st)
  }
}
