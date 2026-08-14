// Provider 门面：统一四种数据源——内置引擎（engine，默认）/ lxserver / mock。
// providerMode：
//   auto      → 配置了 lxServerUrl 用 lxserver，否则用内置引擎
//   engine    → 强制内置引擎（SDK 搜索 + 音源脚本直链）
//   lxserver  → 强制 lxserver（无地址则报错）
//   mock      → 内置演示数据

import { LxClient } from './lxclient'
import { MockProvider } from './mock'
import { EngineProvider } from './engine/musicEngine'
import type { StorageFace } from './playback'
import type { MusicInfo, MusicSource, MusicUrlResult, Quality, SearchOutcome, SearchRequest, SourceEntry } from './shared/types'

export type ProviderMode = 'auto' | 'engine' | 'lxserver' | 'mock'

export interface Provider {
  readonly mode: 'engine' | 'lxserver' | 'mock'
  ping(): Promise<boolean>
  search(req: SearchRequest): Promise<SearchOutcome>
  resolveUrl(music: MusicInfo, quality: Quality): Promise<MusicUrlResult>
  listSources(): Promise<SourceEntry[]>
  validateSource(script: string): Promise<unknown>
  uploadSource(filename: string, content: string): Promise<{ success: boolean; id?: string; error?: string }>
  importSource(url: string, filename?: string): Promise<{ success: boolean; id?: string; error?: string }>
  toggleSource(id: string, enabled: boolean): Promise<{ success: boolean; enabled?: boolean; error?: string }>
  deleteSource(id: string): Promise<{ success: boolean; error?: string }>
  reorderSources(ids: string[]): Promise<{ success: boolean; error?: string }>
}

/** lxserver 门面：把 LxClient 收敛为 Provider 接口（search 走平台优先级编排）。 */
export class LxProviderFacade implements Provider {
  readonly mode = 'lxserver' as const
  private readonly client: LxClient

  constructor(client: LxClient) {
    this.client = client
  }

  async ping(): Promise<boolean> {
    return this.client.ping()
  }

  async search(req: SearchRequest): Promise<SearchOutcome> {
    const sources: MusicSource[] = req.sources && req.sources.length > 0 ? req.sources : ['wy', 'tx', 'kg', 'kw', 'mg']
    return this.client.searchWithFallback(req.query, {
      sources,
      singer: req.singer,
      type: req.type,
      limit: req.limit ?? 20,
      pages: 1,
    })
  }

  async resolveUrl(music: MusicInfo, quality: Quality): Promise<MusicUrlResult> {
    return this.client.resolveUrl(music, quality)
  }

  async listSources(): Promise<SourceEntry[]> {
    return this.client.listSources()
  }

  async validateSource(script: string): Promise<unknown> {
    return this.client.validateSource(script)
  }

  async uploadSource(filename: string, content: string): Promise<{ success: boolean; id?: string; error?: string }> {
    return this.client.uploadSource(filename, content)
  }

  async importSource(url: string, filename?: string): Promise<{ success: boolean; id?: string; error?: string }> {
    return this.client.importSource(url, filename)
  }

  async toggleSource(id: string, enabled: boolean): Promise<{ success: boolean; enabled?: boolean; error?: string }> {
    return this.client.toggleSource(id, enabled)
  }

  async deleteSource(id: string): Promise<{ success: boolean; error?: string }> {
    return this.client.deleteSource(id)
  }

  async reorderSources(ids: string[]): Promise<{ success: boolean; error?: string }> {
    return this.client.reorderSources(ids)
  }
}

export class MockSourceFacade implements Provider {
  readonly mode = 'mock' as const
  private readonly mock: MockProvider
  private sources: SourceEntry[] = []

  constructor(mock: MockProvider) {
    this.mock = mock
  }

  async ping(): Promise<boolean> {
    return true
  }

  async search(req: SearchRequest): Promise<SearchOutcome> {
    return this.mock.search(req.query, { sources: req.sources, singer: req.singer, limit: req.limit })
  }

  async resolveUrl(music: MusicInfo, quality: Quality): Promise<MusicUrlResult> {
    return this.mock.resolveUrl(music, quality)
  }

  async listSources(): Promise<SourceEntry[]> {
    return this.sources
  }

  async validateSource(script: string): Promise<{ valid: boolean; error?: string; metadata?: Record<string, string | undefined>; sources?: string[]; sourcesCount?: number }> {
    const hasInited = script.includes("lx.send('inited'") || script.includes('lx.send("inited"')
    if (!hasInited) return { valid: false, error: '脚本未调用 lx.send("inited", { sources: {...} })' }
    const name = extractName(script)
    return { valid: true, metadata: { name }, sources: ['kw', 'wy', 'kg', 'tx', 'mg'], sourcesCount: 5 }
  }

  async uploadSource(filename: string, content: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const name = extractName(content) ?? filename
    const id = `${name.replace(/[\\/:*?"<>|]/g, '_')}.js`
    this.sources.push({ id, name, version: '1.0.0', author: 'mock', enabled: true, supportedSources: ['wy'], status: 'success', uploadTime: new Date().toISOString() })
    return { success: true, id }
  }

  async importSource(url: string, filename?: string): Promise<{ success: boolean; id?: string; error?: string }> {
    const id = `${(filename ?? 'remote-source').replace(/\.js$/, '').replace(/[\\/:*?"<>|]/g, '_')}.js`
    this.sources.push({ id, name: filename ?? url, version: '1.0.0', author: 'mock', enabled: true, supportedSources: ['kg'], status: 'success', sourceUrl: url, uploadTime: new Date().toISOString() })
    return { success: true, id }
  }

  async toggleSource(id: string, enabled: boolean): Promise<{ success: boolean; enabled?: boolean; error?: string }> {
    const s = this.sources.find((x) => x.id === id)
    if (!s) return { success: false, error: '源不存在' }
    s.enabled = enabled
    return { success: true, enabled }
  }

  async deleteSource(id: string): Promise<{ success: boolean; error?: string }> {
    this.sources = this.sources.filter((x) => x.id !== id)
    return { success: true }
  }

  async reorderSources(ids: string[]): Promise<{ success: boolean; error?: string }> {
    const map = new Map(this.sources.map((s) => [s.id, s]))
    this.sources = ids.map((id) => map.get(id)).filter((x): x is SourceEntry => x !== undefined)
    return { success: true }
  }
}

// 从脚本头部 JSDoc 注释提取 @name（兼容星号斜杠结尾）。
function extractName(script: string): string | undefined {
  return script.match(/@name\s+([^*\n]+?)\s*\*?\//)?.[1]?.trim()
    ?? script.match(/@name\s+([^*\n]+)/)?.[1]?.trim()
}

export interface ProviderSelection {
  lxServerUrl: string
  providerMode: ProviderMode
}

/** 旧 mockMode 值迁移：auto→auto、on→mock、off→lxserver。 */
export function migrateMockMode(value: unknown): ProviderMode {
  if (value === 'on') return 'mock'
  if (value === 'off') return 'lxserver'
  if (value === 'engine' || value === 'lxserver' || value === 'mock') return value as ProviderMode
  return 'auto'
}

/** 按设置选择 provider。 */
export function createProvider(settings: ProviderSelection, deps: { storage?: StorageFace } = {}): Provider {
  const mode = migrateMockMode(settings.providerMode)
  if (mode === 'engine') return new EngineProvider({ storage: deps.storage })
  if (mode === 'mock') return new MockSourceFacade(new MockProvider())
  if (mode === 'lxserver') {
    if (!settings.lxServerUrl) throw new Error('providerMode 为 lxserver 但未配置 lxServerUrl')
    return new LxProviderFacade(new LxClient({ baseUrl: settings.lxServerUrl }))
  }
  // auto
  if (settings.lxServerUrl) return new LxProviderFacade(new LxClient({ baseUrl: settings.lxServerUrl }))
  return new EngineProvider({ storage: deps.storage })
}
