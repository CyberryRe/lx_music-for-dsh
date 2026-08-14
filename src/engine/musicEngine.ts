// 内置音源引擎（EngineProvider）：完全独立于 lxserver。
// - 搜索：内置音乐 SDK（移植自 lx-music-desktop，五平台）
// - 直链解析：node:vm 音源脚本沙箱（lx-music-desktop 音源脚本协议）
// - 音源管理：本地持久化（storage domain sources 表）

import type { MusicInfo, MusicQualityType, MusicSource, MusicUrlResult, Quality, SearchOutcome, SearchRequest, SourceEntry } from '../shared/types'
import type { Provider } from '../provider'
import { searchWithPriority } from '../sdk'
import { loadSourceScript, type LoadedSourceScript, extractScriptMetadata, SourceScriptError, getSandboxRequestLog } from './sandbox'
import { DomainSourceStore, FileSourceStore, type SourceRecord, type SourceStoreFace } from './sourceStore'
import { httpFetch } from '../sdk/request'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 直链解析时 songInfo 的平台字段标准化（与 lxserver normalizeSongInfo 一致）。 */
export function normalizeSongInfo(music: MusicInfo): Record<string, unknown> {
  const info: Record<string, unknown> = { ...music }
  const meta = music.meta ?? {}
  // meta 字段提升
  if (meta.songId !== undefined) info.songmid = meta.songId
  if (meta.picUrl !== undefined) info.img = meta.picUrl
  if (meta.qualitys !== undefined) info.types = meta.qualitys
  if (meta.hash !== undefined) info.hash = meta.hash
  if (meta.albumId !== undefined) info.albumId = meta.albumId
  if (meta.copyrightId !== undefined) info.copyrightId = meta.copyrightId
  if (meta.lrcUrl !== undefined) info.lrcUrl = meta.lrcUrl
  if (meta.mrcUrl !== undefined) info.mrcUrl = meta.mrcUrl
  if (meta.trcUrl !== undefined) info.trcUrl = meta.trcUrl
  if (meta.strMediaMid !== undefined) info.strMediaMid = meta.strMediaMid
  if (meta.albumMid !== undefined) info.albumMid = meta.albumMid
  return info
}

export interface EngineOptions {
  storage?: { table(name: string): { get(k: string): unknown; put(k: string, v: unknown): Promise<void>; entries(): IterableIterator<[string, unknown]>; delete(k: string): Promise<boolean> } }
  /** 音源持久化文件路径（不依赖 storage domain 时使用）。 */
  sourceFile?: string
}

/** 默认音源持久化文件：$DSH_HOME/storages/lx-music-sources.json。 */
export function defaultSourceFile(): string {
  const fromEnv = process.env.DSH_HOME
  const home = fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.dsh')
  return join(home, 'storages', 'lx-music-sources.json')
}

export class EngineProvider implements Provider {
  readonly mode = 'engine' as const
  private readonly store: SourceStoreFace
  private readonly scripts = new Map<string, LoadedSourceScript>()

  constructor(options: EngineOptions = {}) {
    // 持久化优先级：显式文件 → storage domain → 默认文件（保证音源重启不丢）
    this.store = options.sourceFile
      ? new FileSourceStore(options.sourceFile)
      : options.storage
        ? new DomainSourceStore(options.storage as never)
        : new FileSourceStore(defaultSourceFile())
    void this.reload()
  }

  // ── 脚本生命周期 ──────────────────────────────────────────────────────────

  /** 重新加载全部已启用脚本（启用/导入/删除后调用）。 */
  async reload(): Promise<void> {
    for (const script of this.scripts.values()) script.dispose()
    this.scripts.clear()
    const records = this.store.list().filter((r) => r.enabled)
    await Promise.all(
      records.map(async (record) => {
        try {
          const loaded = await loadSourceScript(record.id, record.script)
          this.scripts.set(record.id, loaded)
          record.lastError = undefined
          // 自愈：更新支持的平台列表
          const supported = Object.keys(loaded.sources).sort()
          if (JSON.stringify(supported) !== JSON.stringify((record.supportedSources ?? []).sort())) {
            record.supportedSources = supported
            await this.store.put(record)
          }
        } catch (err) {
          record.lastError = err instanceof Error ? err.message : String(err)
          await this.store.put(record).catch(() => undefined)
        }
      }),
    )
  }

  /** 支持某平台的已启用脚本（按 order 顺序）。 */
  private scriptsFor(source: string): LoadedSourceScript[] {
    const order = this.store.order()
    const byId = new Map(this.scripts)
    const ordered: LoadedSourceScript[] = []
    for (const id of order) {
      const s = byId.get(id)
      if (s && s.sources[source]) {
        ordered.push(s)
        byId.delete(id)
      }
    }
    for (const s of byId.values()) {
      if (s.sources[source]) ordered.push(s)
    }
    return ordered
  }

  // ── Provider: 搜索（内置 SDK） ────────────────────────────────────────────

  async search(req: SearchRequest): Promise<SearchOutcome> {
    const sources: MusicSource[] = req.sources && req.sources.length > 0 ? req.sources : ['wy', 'tx', 'kg', 'kw', 'mg']
    const query = req.singer ? `${req.query} ${req.singer}`.trim() : req.query
    return searchWithPriority(query, { sources, limit: req.limit ?? 20 })
  }

  // ── Provider: 直链解析（音源脚本） ────────────────────────────────────────

  async resolveUrl(music: MusicInfo, quality: Quality): Promise<MusicUrlResult> {
    const candidates = this.scriptsFor(music.source)
    if (candidates.length === 0) {
      throw new Error(`未找到支持 ${music.source} 平台的已启用音源脚本，请先在「设置 → 音源管理」中导入`)
    }
    const errors: string[] = []
    for (const script of candidates) {
      try {
        const url = await script.call('musicUrl', music.source, {
          musicInfo: normalizeSongInfo(music),
          quality,
          type: quality,
        })
        if (typeof url === 'string' && url.startsWith('http')) {
          return { url, type: quality, sourceName: script.name }
        }
        errors.push(`${script.name}: 返回了无效直链`)
        console.warn(`[lx-music] 音源脚本「${script.name}」返回了无效直链（${music.source}/${quality}，歌曲「${music.name}」）`)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`${script.name}: ${message}`)
        // 完整错误（含堆栈）打到宿主进程 stdout，供诊断
        console.error(`[lx-music] 直链解析失败 - 脚本「${script.name}」 ${music.source}/${quality} 歌曲「${music.name} - ${music.singer}」: ${message}`, err instanceof Error ? err : undefined)
      }
    }
    const message = `直链解析失败（${music.name} - ${music.singer} [${music.source}]）：${errors.join('；')}`
    const err = new Error(message) as Error & { attempts?: unknown[] }
    err.attempts = errors.map((e) => ({ name: 'engine', status: 'fail', message: e }))
    // 附上最近的音源脚本 HTTP 请求日志（状态码能区分 IP 封禁 403 / 服务宕机 503 / 超时）
    const recent = getSandboxRequestLog()
      .slice(-5)
      .map((r) => `[${new Date(r.ts).toLocaleTimeString()}] ${r.statusCode ?? 'ERR'} ${r.error ?? ''} ${r.url}(${r.ms}ms)`)
    if (recent.length > 0) {
      console.error(`[lx-music] 最近音源脚本请求:\n  ${recent.join('\n  ')}`)
    }
    throw err
  }

  // ── Provider: 音源管理 ────────────────────────────────────────────────────

  async listSources(): Promise<SourceEntry[]> {
    return this.store
      .list()
      .sort((a, b) => this.store.order().indexOf(a.id) - this.store.order().indexOf(b.id))
      .map((r) => ({
        id: r.id,
        name: r.name,
        version: r.version,
        author: r.author,
        description: r.description,
        homepage: r.homepage,
        supportedSources: r.supportedSources,
        enabled: r.enabled,
        sourceUrl: r.sourceUrl,
        uploadTime: r.createdAt,
        status: r.lastError ? 'failed' : ('success' as const),
        error: r.lastError,
      }))
  }

  async validateSource(script: string): Promise<{ valid: boolean; error?: string; metadata?: Record<string, string | undefined>; sources?: string[]; sourcesCount?: number; requireUnsafe?: boolean }> {
    const metadata = extractScriptMetadata(script)
    try {
      const loaded = await loadSourceScript('temp_validate', script, { initTimeoutMs: 3000 })
      const sources = Object.keys(loaded.sources)
      loaded.dispose()
      if (sources.length === 0) {
        return { valid: false, error: '脚本没有注册任何音源。请确保脚本正确调用了 lx.send("inited", { sources: {...} })', metadata }
      }
      return { valid: true, metadata, sources, sourcesCount: sources.length }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err), metadata }
    }
  }

  /** 加载脚本到运行时（先验证再持久化用）。失败时清理并抛错。 */
  private async loadInto(record: SourceRecord): Promise<void> {
    const existing = this.scripts.get(record.id)
    if (existing) existing.dispose()
    const loaded = await loadSourceScript(record.id, record.script)
    this.scripts.set(record.id, loaded)
    record.lastError = undefined
    record.supportedSources = Object.keys(loaded.sources)
  }

  async uploadSource(filename: string, content: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const metadata = extractScriptMetadata(content)
    if (!metadata.name) metadata.name = filename.replace(/\.js$/i, '')
    const id = `${metadata.name.replace(/[\\/:*?"<>|]/g, '_')}.js`
    const now = new Date().toISOString()
    const record: SourceRecord = {
      id,
      name: metadata.name,
      version: metadata.version,
      author: metadata.author,
      description: metadata.description,
      homepage: metadata.homepage,
      script: content,
      enabled: true, // 导入后自动启用
      createdAt: now,
      updatedAt: now,
    }
    try {
      // 先验证脚本可加载，再持久化（坏脚本不落盘）
      await this.loadInto(record)
      await this.store.put(record)
      return { success: true, id }
    } catch (err) {
      this.scripts.delete(id)
      return { success: false, error: err instanceof SourceScriptError ? err.message : err instanceof Error ? err.message : String(err) }
    }
  }

  async importSource(url: string, filename?: string): Promise<{ success: boolean; id?: string; error?: string }> {
    try {
      const result = await httpFetch(url, { timeout: 10_000 }).promise
      const content = result.body
      if (typeof content !== 'string') {
        return { success: false, error: 'URL 内容不是文本（音源脚本应为 .js 文件）' }
      }
      return this.uploadSource(filename ?? url.split('/').pop() ?? 'remote-source.js', content)
    } catch (err) {
      return { success: false, error: `下载失败: ${err instanceof Error ? err.message : String(err)}` }
    }
  }

  async toggleSource(id: string, enabled: boolean): Promise<{ success: boolean; enabled?: boolean; error?: string }> {
    const record = this.store.get(id)
    if (!record) return { success: false, error: '源不存在' }
    record.updatedAt = new Date().toISOString()
    if (enabled) {
      record.enabled = true
      try {
        await this.loadInto(record)
        await this.store.put(record)
        return { success: true, enabled: true }
      } catch (err) {
        // 启用失败：回滚为禁用并保留记录，返回错误信息
        this.scripts.delete(id)
        record.enabled = false
        record.lastError = err instanceof Error ? err.message : String(err)
        await this.store.put(record).catch(() => undefined)
        return { success: false, error: record.lastError }
      }
    }
    record.enabled = false
    const script = this.scripts.get(id)
    if (script) {
      script.dispose()
      this.scripts.delete(id)
    }
    await this.store.put(record)
    return { success: true, enabled: false }
  }

  async deleteSource(id: string): Promise<{ success: boolean; error?: string }> {
    const script = this.scripts.get(id)
    if (script) {
      script.dispose()
      this.scripts.delete(id)
    }
    await this.store.remove(id)
    return { success: true }
  }

  async reorderSources(ids: string[]): Promise<{ success: boolean; error?: string }> {
    await this.store.setOrder(ids)
    return { success: true }
  }

  /** 直链预览需要的音质列表（供工具展示）。 */
  qualitysOf(music: MusicInfo): MusicQualityType[] {
    return music.meta.qualitys ?? []
  }

  async ping(): Promise<boolean> {
    return true
  }
}
