// lx-music-for-dsh 插件 host 入口。
// 注册：PlaybackService（Typert Remote，client 通过 ctx.remote.lxPlayback.* 调用）、
//       search_and_play LLM 工具、storage domain（播放状态/设置/点歌日志持久化）。

import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { PlaybackService, adaptDomain } from './playback'
import { registerSearchAndPlayTool } from './tools'
import { SlidingWindowRateLimiter } from './ratelimit'
import { DEFAULT_SETTINGS, type PluginSettings } from './shared/types'

export const name = 'lx-music-for-dsh'

export const inject = ['tools', 'storageDomain']

/** 插件配置（schemastery；行配置缺省时回退 DEFAULT_SETTINGS）。 */
export const Config = z.object({
  lxServerUrl: z.string().required().default(DEFAULT_SETTINGS.lxServerUrl),
  defaultQuality: z.string().required().default(DEFAULT_SETTINGS.defaultQuality),
  qualityFallbackChain: z.array(z.string()).required().default(DEFAULT_SETTINGS.qualityFallbackChain),
  platformPriority: z.array(z.string()).required().default(DEFAULT_SETTINGS.platformPriority),
  autoPullHighestOnSwitch: z.boolean().required().default(DEFAULT_SETTINGS.autoPullHighestOnSwitch),
  fallbackStrategy: z.string().required().default(DEFAULT_SETTINGS.fallbackStrategy),
  rateLimitPerMinute: z.number().required().default(DEFAULT_SETTINGS.rateLimitPerMinute),
  providerMode: z.string().required().default(DEFAULT_SETTINGS.providerMode),
})

const qualityEnum = zod.enum(['128k', '320k', 'flac', 'flac24bit', 'flac32bit', 'wav'])

/** storage domain：播放状态 global + 点歌日志表 + 音源脚本表。 */
const domainSpec = defineDomain({
  name: 'lx_music',
  version: 1,
  global: {
    schema: zod.object({
      playlist: zod.array(zod.unknown()),
      currentIndex: zod.number(),
      quality: qualityEnum,
      volume: zod.number(),
      mute: zod.boolean(),
      settings: zod.unknown().optional(),
    }),
    initial: { playlist: [], currentIndex: -1, quality: '320k' as const, volume: 1, mute: false },
  },
  tables: {
    logs: domainTable(
      zod.object({
        time: zod.string(),
        query: zod.string(),
        limit: zod.number(),
        autoPlay: zod.boolean(),
        source: zod.string().nullable(),
        resultsCount: zod.number(),
        playedId: zod.string().nullable(),
        latencyMs: zod.number(),
        error: zod.string().optional(),
      }),
    ),
    sources: domainTable(
      zod.object({
        id: zod.string(),
        name: zod.string(),
        version: zod.string().optional(),
        author: zod.string().optional(),
        description: zod.string().optional(),
        homepage: zod.string().optional(),
        script: zod.string(),
        enabled: zod.boolean(),
        supportedSources: zod.array(zod.string()).optional(),
        sourceUrl: zod.string().optional(),
        createdAt: zod.string(),
        updatedAt: zod.string(),
        lastError: zod.string().optional(),
      }),
    ),
    source_order: domainTable(
      zod.object({
        order: zod.array(zod.string()),
      }),
    ),
  },
})

function toSettings(config: Record<string, unknown>): PluginSettings {
  const base = { ...DEFAULT_SETTINGS } as Record<string, unknown>
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    const v = config[key]
    if (v !== undefined && v !== null && v !== '') base[key] = v
  }
  return base as unknown as PluginSettings
}

export async function apply(ctx: {
  tools: { register(tool: unknown): void }
  storageDomain?: { open(spec: unknown): Promise<unknown> }
  logger?: { warn(...args: unknown[]): void }
}, rawConfig: Record<string, unknown>): Promise<void> {
  const settings = toSettings(rawConfig)
  const logger = ctx.logger ?? console

  // 限流器（LLM 点歌防刷）
  const rateLimiter = new SlidingWindowRateLimiter({
    maxCalls: settings.rateLimitPerMinute,
    windowMs: 60_000,
  })

  // storage domain（可选：storageDomain 服务不可用时仅内存）
  let storage: ReturnType<typeof adaptDomain> | undefined
  if (ctx.storageDomain) {
    try {
      const domain = (await ctx.storageDomain.open(domainSpec)) as Parameters<typeof adaptDomain>[0]
      storage = adaptDomain(domain)
    } catch (err) {
      logger.warn('[lx-music-for-dsh] storage domain 打开失败，使用内存存储:', err)
    }
  }

  // 播放服务（Typert Remote：lxPlayback）
  const service = new PlaybackService(ctx as never, {
    storage,
    settings,
    rateLimiter,
    onSettingsChange: (s) => {
      // rateLimitPerMinute 变更 → 重建限流器
      if (s.rateLimitPerMinute !== settings.rateLimitPerMinute) {
        rateLimiter.reset()
        rateLimiter.setMaxCalls(s.rateLimitPerMinute)
        settings.rateLimitPerMinute = s.rateLimitPerMinute
      }
    },
    onLog: (entry) => {
      if (storage) {
        storage.table('logs').put(entry.time, entry).catch((err) => logger.warn('[lx-music-for-dsh] 日志写入失败:', err))
      }
    },
  })

  // LLM 点歌工具
  registerSearchAndPlayTool(ctx, { service })

  logger.warn('[lx-music-for-dsh] 插件已加载，provider:', service.getProviderMode())
}
