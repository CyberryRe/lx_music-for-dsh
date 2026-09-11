// lx-music-for-dsh 插件 host 入口。
// 注册：PlaybackService（Typert Remote，client 通过 ctx.remote.lxPlayback.* 调用）、
//       search_and_play LLM 工具、storage domain（播放状态/设置/点歌日志持久化）。

import z from '@deepseek-ai/schemastery'
import { z as zod } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { PlaybackService, adaptDomain } from './playback'
import { registerMusicTools } from './tools'
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
const playModeEnum = zod.enum(['list', 'single', 'order', 'shuffle'])

/**
 * storage domain：播放状态 global + 点歌日志表 + 音源脚本表 + 音源顺序表。
 *
 * 注意：这些 schema 是**持久层的读边界校验**（`DomainSpec` 文档：每个存储记录在
 * durable 边界被校验，任一条不匹配会让整个 `open` 以 `invalid-record` 失败）。
 * 因此每个 schema 必须与代码实际写入的形状**逐字段**一致，否则插件会静默降级为
 * 内存存储（播放列表/设置/音源全部不落盘）。两条历史教训：
 *   - `source_order` 的代码（engine/sourceStore.ts）往键 `order` 写的是**裸 string[]**，
 *     早期 schema 却声明为 `{ order: string[] }` 对象 → 旧数据直接让 open 失败；
 *   - `global` 早期漏声明 `playMode`，而 zod 对象默认丢弃未声明键 → 播放模式永远读不回来。
 */
export const domainSpec = defineDomain({
  name: 'lx_music',
  version: 1,
  global: {
    schema: zod.object({
      playlist: zod.array(zod.unknown()),
      currentIndex: zod.number(),
      quality: qualityEnum,
      volume: zod.number(),
      mute: zod.boolean(),
      playMode: playModeEnum.optional(),
      settings: zod.unknown().optional(),
    }),
    initial: { playlist: [], currentIndex: -1, quality: '320k' as const, volume: 1, mute: false },
  },
  tables: {
    logs: domainTable(
      zod.object({
        time: zod.string(),
        action: zod.string().optional(),
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
    // 记录形状 = 裸 id 数组（键固定为 'order'，见 engine/sourceStore.ts）。
    source_order: domainTable(zod.array(zod.string())),
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
      // 双写：ctx.logger 由宿主决定去向（可能被日志级别吞掉），console 保证终端可见。
      // 这条降级是静默的（UI 仍然可用，只是状态不落盘），必须显式告警。
      logger.warn('[lx-music-for-dsh] storage domain 打开失败，使用内存存储:', err)
      console.error('[lx-music-for-dsh] storage domain 打开失败，本次运行播放列表/设置不会持久化:', err)
    }
  } else {
    console.error('[lx-music-for-dsh] storageDomain 服务不可用，本次运行播放列表/设置不会持久化')
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

  // LLM 音乐工具集（细粒度：搜索/播放/播放列表/上下首/控制 + 兼容 search_and_play）
  registerMusicTools(ctx, { service })

  // 插件卸载时释放音源子进程（避免孤儿进程）
  const disposeHook = (ctx as { on?: (event: string, fn: () => void) => void }).on
  disposeHook?.('dispose', () => service.disposeProvider())

  // ctx.logger 的去向由宿主决定（可能被日志级别过滤），启动行同时写 stdout，
  // 便于按 docs/development.md §4.1 在启动 dsh 的终端直接确认插件是否加载。
  const status = `[lx-music-for-dsh] 插件已加载，provider: ${service.getProviderMode()}，storage: ${storage ? 'durable' : 'memory'}`
  logger.warn(status)
  console.info(status)
}
