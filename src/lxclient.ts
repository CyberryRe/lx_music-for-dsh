// lxserver（LX Music 服务端）HTTP 客户端。
// 封装：搜索、直链解析、歌词、音源管理；统一超时（默认 10s）与重试（最多 2 次）。

import type {
  MusicInfo,
  MusicSource,
  MusicUrlResult,
  Quality,
  SearchOutcome,
  SourceEntry,
} from './shared/types'

export interface LxClientOptions {
  baseUrl: string
  timeoutMs?: number
  retries?: number
  /** 请求头附加（如 x-frontend-auth / x-user-name）。 */
  headers?: Record<string, string>
}

export class LxHttpError extends Error {
  readonly status: number
  readonly code: string
  readonly attempts?: unknown[]

  constructor(message: string, status: number, code: string, attempts?: unknown[]) {
    super(message)
    this.name = 'LxHttpError'
    this.status = status
    this.code = code
    this.attempts = attempts
  }
}

export class LxClient {
  readonly mode = 'lxserver' as const
  readonly baseUrl: string
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly extraHeaders: Record<string, string>

  constructor(options: LxClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? 10_000
    this.retries = Math.max(0, options.retries ?? 2)
    this.extraHeaders = options.headers ?? {}
  }

  /** 请求封装：超时 + 重试（最多 retries 次）。JSON 已解析。 */
  async request<T>(path: string, init: RequestInit = {}, attempt = 0): Promise<T> {
    const url = `${this.baseUrl}${path}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(url, {
        ...init,
        headers: { ...this.extraHeaders, ...(init.headers as Record<string, string> | undefined) },
        signal: controller.signal,
      })
      const text = await res.text()
      let body: unknown = null
      if (text) {
        try {
          body = JSON.parse(text)
        } catch {
          body = text
        }
      }
      if (!res.ok) {
        const errBody = (body as { error?: string; message?: string; code?: string }) ?? {}
        throw new LxHttpError(
          errBody.error ?? errBody.message ?? `HTTP ${res.status}`,
          res.status,
          String(errBody.code ?? res.status),
          (body as { attempts?: unknown[] })?.attempts,
        )
      }
      return body as T
    } catch (err) {
      if (err instanceof LxHttpError) throw err
      if (attempt < this.retries) {
        return this.request<T>(path, init, attempt + 1)
      }
      const message = err instanceof Error && err.name === 'AbortError'
        ? `请求超时（>${this.timeoutMs}ms）`
        : err instanceof Error ? err.message : String(err)
      throw new LxHttpError(message, 0, 'network-error')
    } finally {
      clearTimeout(timer)
    }
  }

  /** 健康检查。 */
  async ping(): Promise<boolean> {
    try {
      await this.request<unknown>('/api/status', { method: 'GET' })
      return true
    } catch {
      return false
    }
  }

  /** 歌曲搜索（lxserver GET /api/music/search）。 */
  async search(
    query: string,
    options: { source?: MusicSource; singer?: string; type?: string; limit?: number; pages?: number } = {},
  ): Promise<MusicInfo[]> {
    const params = new URLSearchParams({ name: query })
    if (options.source) params.set('source', options.source)
    if (options.singer) params.set('singer', options.singer)
    if (options.type) params.set('type', options.type)
    if (options.limit) params.set('limit', String(options.limit))
    if (options.pages) params.set('pages', String(options.pages))
    const list = await this.request<MusicInfo[]>(`/api/music/search?${params.toString()}`)
    return Array.isArray(list) ? list : []
  }

  /**
   * 带平台优先级与降级策略的搜索编排。
   * 依次尝试 platformPriority 中的平台，第一个返回非空结果的平台胜出；
   * 所有平台失败时返回 attempts 供上层提示。
   */
  async searchWithFallback(
    query: string,
    options: {
      sources?: MusicSource[]
      singer?: string
      type?: string
      limit?: number
      pages?: number
    } = {},
  ): Promise<SearchOutcome> {
    const sources: MusicSource[] = options.sources && options.sources.length > 0 ? options.sources : ['wy', 'tx', 'kg', 'kw', 'mg']
    const attempts: SearchOutcome['attempts'] = []
    for (const source of sources) {
      try {
        const list = await this.search(query, {
          source,
          singer: options.singer,
          type: options.type,
          limit: options.limit ?? 20,
          pages: options.pages ?? 1,
        })
        attempts.push({ source, status: list.length > 0 ? 'success' : 'fail', count: list.length })
        if (list.length > 0) {
          return { results: list, usedSource: source, attempts }
        }
      } catch (err) {
        attempts.push({ source, status: 'fail', count: 0, error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { results: [], usedSource: null, attempts }
  }

  /**
   * 直链解析（lxserver POST /api/music/url）。
   * quality 为期望音质；服务端按自定义源优先级解析。
   */
  async resolveUrl(songInfo: MusicInfo, quality: Quality, enableAutoSwitchApiSource = true): Promise<MusicUrlResult> {
    return this.request<MusicUrlResult>('/api/music/url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songInfo, quality, enableAutoSwitchApiSource }),
    })
  }

  /** 歌词（POST /api/music/lyric）。 */
  async getLyric(songInfo: MusicInfo): Promise<{ lyric?: string; tlyric?: string }> {
    return this.request<{ lyric?: string; tlyric?: string }>('/api/music/lyric', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ songInfo }),
    })
  }

  // ── 音源管理（/api/custom-source/*） ──────────────────────────────────────

  /** 校验音源脚本。 */
  async validateSource(script: string): Promise<{
    valid: boolean
    error?: string
    metadata?: Record<string, string | undefined>
    sources?: string[]
    sourcesCount?: number
    requireUnsafe?: boolean
  }> {
    return this.request('/api/custom-source/validate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ script, username: 'default', allowUnsafeVM: false }),
    })
  }

  /** 上传音源脚本（成功后自动启用）。 */
  async uploadSource(filename: string, content: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const result = await this.request<{ success: boolean; id?: string; error?: string }>('/api/custom-source/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename, content, username: 'default', allowUnsafeVM: false }),
    })
    if (result.success && result.id) {
      await this.toggleSource(result.id, true).catch(() => undefined) // 导入后自动启用
    }
    return result
  }

  /** 从 URL 导入音源脚本（成功后自动启用）。 */
  async importSource(url: string, filename?: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const result = await this.request<{ success: boolean; id?: string; error?: string }>('/api/custom-source/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, filename, username: 'default', allowUnsafeVM: false }),
    })
    if (result.success && result.id) {
      await this.toggleSource(result.id, true).catch(() => undefined) // 导入后自动启用
    }
    return result
  }

  /** 音源列表。 */
  async listSources(): Promise<SourceEntry[]> {
    const list = await this.request<SourceEntry[]>('/api/custom-source/list?username=default')
    return Array.isArray(list) ? list : []
  }

  /** 启用/禁用音源。 */
  async toggleSource(id: string, enabled: boolean): Promise<{ success: boolean; enabled?: boolean; error?: string }> {
    return this.request('/api/custom-source/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, enabled, username: 'default' }),
    })
  }

  /** 删除音源。 */
  async deleteSource(id: string): Promise<{ success: boolean; error?: string }> {
    return this.request('/api/custom-source/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, username: 'default' }),
    })
  }

  /** 音源排序（= 解析优先级）。 */
  async reorderSources(sourceIds: string[]): Promise<{ success: boolean; error?: string }> {
    return this.request('/api/custom-source/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceIds, username: 'default' }),
    })
  }
}
