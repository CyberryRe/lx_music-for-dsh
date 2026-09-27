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
import { memoryConfigSchema, normalizeMemoryConfig } from './taste/config'
import { storedArtistSchema, storedTagSchema, storedTrackSchema, tasteEventDaySchema, tasteStateSchema } from './taste/schema'
import { TasteStore } from './taste/store'
import { TasteRecorder } from './taste/recorder'
import { TasteFacade } from './taste/facade'
import { registerTasteTools } from './taste/tools'
import { TASTE_SKILL, TASTE_SKILL_NAME } from './taste/skill'
import { defaultDomainFile, migrateLegacyDomain, needsLegacyMigration, perRecordDir, readLegacyWholeUnit, restoreLegacyFile, stashLegacyFile } from './storage/migrate'
import { storageKey } from './storage/keys'
import { recordStatus } from './status'
import type { StorageFace } from './playback'

export const name = 'lx-music-for-dsh'

// 只声明**真正必需**的依赖：storageDomain 是可选能力（缺了就内存模式跑），
// 一旦写进 inject，服务未就绪时 cordis 根本不会调用 apply —— 服务/工具/画像全部消失，
// 客户端表现为 lxPlayback/* 一律 404（1.2.0 桌面版实测）。存储改由作用域注入迟到挂载。
export const inject = ['tools']

/**
 * 插件配置（schemastery）。
 *
 * **每个字段都必须能在"行配置什么都不给"时成立**：schemastery 的 `.required()` 要求
 * 行配置显式提供该字段，`.default()` 兜不住它。1.2.0 就是在这里翻车的——
 * 新增了 `migrateLegacyDomain: z.boolean().required().default(true)`，却没同步进
 * `cordis.patch.yml` 的行配置，于是 cordis 在 `resolveConfig` 阶段直接判插件配置非法：
 *
 *     启用失败：1 entry did not activate lx-music … ValidationError: invalid config:
 *     - $.migrateLegacyDomain missing required value (at migrateLegacyDomain)
 *
 * 插件**根本不会被调用**（服务/工具/存储一概不存在，客户端表现为 `lxPlayback/*` 全 404）。
 * 用户如果自己写 profile patch（`- id: lx-music`，patch 是整行替换、不做深度合并），
 * 行配置会整体消失，所以"缺省即可用"不是可选优化而是硬要求。
 * 回归锁：tests/activation.test.ts 里 `Config({})` 必须通过，且随包 patch 的 config 也要通过。
 */
export const Config = z.object({
  lxServerUrl: z.string().default(DEFAULT_SETTINGS.lxServerUrl),
  defaultQuality: z.string().default(DEFAULT_SETTINGS.defaultQuality),
  qualityFallbackChain: z.array(z.string()).default(DEFAULT_SETTINGS.qualityFallbackChain),
  platformPriority: z.array(z.string()).default(DEFAULT_SETTINGS.platformPriority),
  autoPullHighestOnSwitch: z.boolean().default(DEFAULT_SETTINGS.autoPullHighestOnSwitch),
  fallbackStrategy: z.string().default(DEFAULT_SETTINGS.fallbackStrategy),
  rateLimitPerMinute: z.number().default(DEFAULT_SETTINGS.rateLimitPerMinute),
  providerMode: z.string().default(DEFAULT_SETTINGS.providerMode),
  // 一次性把旧版 single 布局的数据迁到 per-record（默认开）。
  // 关闭仅用于测试/嵌入方，避免在用户真实 $DSH_HOME 上产生写盘副作用。
  migrateLegacyDomain: z.boolean().default(true),
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
  // 1.2.0：从 single 换成 per-record —— 每次写只重写一条记录，而不是整份文件
  // （events/画像表写入频繁，single 的写放大不可接受）。
  // 并且 invalidRecords 只在 per-record 下生效（single 下坏记录仍会殉爆整个 open，
  // 这正是 1.0.1 的事故机制）；两者是绑定的，见 docs/design-taste-memory.md §2。
  layout: 'per-record',
  invalidRecords: 'backup-and-skip',
  global: {
    schema: zod.object({
      playlist: zod.array(zod.unknown()),
      currentIndex: zod.number(),
      quality: qualityEnum,
      volume: zod.number(),
      mute: zod.boolean(),
      playMode: playModeEnum.optional(),
      settings: zod.unknown().optional(),
      // 音乐画像配置（1.2.0）；字段全部可选，读侧用 normalizeMemoryConfig 合并默认值
      memory: memoryConfigSchema.optional(),
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
    // ---- 音乐画像（1.2.0）----
    // 事件按天分桶（键 = YYYY-MM-DD）：per-record 布局下一条事件一个文件会产生几千个小文件，
    // 按天分桶后是"每天一个文件"，裁剪只是删键。
    taste_events: domainTable(tasteEventDaySchema),
    taste_tracks: domainTable(storedTrackSchema),
    taste_artists: domainTable(storedArtistSchema),
    taste_tags: domainTable(storedTagSchema),
    taste_state: domainTable(tasteStateSchema),
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
  skills?: { register(skill: unknown): () => void }
  /** 可选注入钩子：skill/storage 服务在旧版/精简宿主里可能不存在，用作用域注入避免拖垮插件激活。 */
  inject?: (deps: string[], fn: (scoped: { skills?: { register(skill: unknown): () => void }; storageDomain?: { open(spec: unknown): Promise<unknown> } }) => void) => unknown
  logger?: { warn(...args: unknown[]): void }
}, rawConfig: Record<string, unknown>): Promise<void> {
  // 进入即落盘：这样"插件到底有没有被激活"永远可查（桌面版看不到 console 输出）。
  recordStatus({
    phase: 'enter',
    services: {
      tools: Boolean(ctx.tools),
      storageDomain: Boolean(ctx.storageDomain),
      skills: Boolean(ctx.skills),
      inject: typeof ctx.inject === 'function',
    },
    storage: 'pending',
  })

  const settings = toSettings(rawConfig)
  const logger = ctx.logger ?? console
  // 迁移开关：默认开；只有显式 false / 'false' 才关闭（YAML 行配置可能给字符串）
  const migrateLegacy = !(rawConfig.migrateLegacyDomain === false || rawConfig.migrateLegacyDomain === 'false')

  // 限流器（LLM 点歌防刷）
  const rateLimiter = new SlidingWindowRateLimiter({
    maxCalls: settings.rateLimitPerMinute,
    windowMs: 60_000,
  })

  // storage domain（可选：storageDomain 服务不可用时仅内存）
  //
  // 注意：这里的"可选"必须与 `inject` 声明一致。1.2.0 曾把 storageDomain 写进 inject
  // （=必需依赖），一旦存储服务没就绪，cordis **根本不调用 apply** —— 服务与工具全都不存在，
  // 客户端表现为 `lxPlayback/*` 一律 404。现在 inject 只留 `tools`，存储走
  // "就绪就挂上、没就绪先内存跑"的路径，并把过程写入状态文件（src/status.ts）。
  let storage: ReturnType<typeof adaptDomain> | undefined
  if (ctx.storageDomain) {
    // 一次性迁移的前置：**先读旧数据、把旧文件改名搁置，再打开 domain**。
    //
    // 为什么顺序不能反：JSON backend 的 legacy bootstrap 会用旧文件的**原始键**当文件名
    // （不做转义），而 `logs` 表的键是 ISO 时间戳（含冒号，Windows 文件名非法）→
    // bootstrap 抛 ENOENT → 整个 open() 失败 → 插件静默退化成内存存储。
    // 把旧文件改名后 bootstrap 不再触发，迁移完全由下面显式完成。
    const legacyPath = defaultDomainFile()
    const legacy = readLegacyWholeUnit(legacyPath)
    const needsMigration = migrateLegacy !== false && needsLegacyMigration(domainSpec.name)
    const stashed = needsMigration ? stashLegacyFile() : undefined
    const stashInfo = !needsMigration
      ? `不需要（目录已存在或旧文件不在：${perRecordDir(domainSpec.name)}）`
      : stashed
        ? `已搁置 → ${stashed}`
        : '搁置失败（改名未成功，旧文件仍在原位）'
    if (stashed) {
      const msg = `[lx-music-for-dsh] 旧存储已改名搁置（迁移用）：${stashed}`
      logger.warn(msg)
      console.info(msg)
    }
    try {
      const domain = (await ctx.storageDomain.open(domainSpec)) as Parameters<typeof adaptDomain>[0]
      storage = adaptDomain(domain)
      // 显式迁移（表记录 + global）：必须在 PlaybackService 读取 global **之前**执行，
      // 否则会先读到默认值再被覆盖。键统一过 storageKey()（旧键可能含 Windows 非法字符）。
      let migrationInfo = '无旧数据'
      if (migrateLegacy !== false && legacy) {
        const result = await migrateLegacyDomain({
          target: storage,
          specTables: Object.keys(domainSpec.tables),
          legacyPath: stashed ?? legacyPath,
          legacy,
          log: (msg) => {
            logger.warn(msg)
            console.info(msg)
          },
          warn: (msg) => {
            logger.warn(msg)
            console.error(msg)
          },
        })
        migrationInfo = result.migrated
          ? `完成（${JSON.stringify(result.tables)}，global=${String(result.globalSource)}）`
          : `未完成（${result.reason}）`
      }
      recordStatus({ phase: 'storage-ready', storage: 'durable', domain: 'ok', stash: stashInfo, migration: migrationInfo })
    } catch (err) {
      // 打开失败 → 把搁置的旧文件还原，保证用户数据始终在原位、旧版本仍能读回
      const restored = restoreLegacyFile(stashed)
      if (restored) {
        const msg = '[lx-music-for-dsh] storage 打开失败，已把旧存储还原回原位'
        logger.warn(msg)
        console.error(msg)
      }
      // 双写：ctx.logger 由宿主决定去向（可能被日志级别吞掉），console 保证终端可见。
      // 这条降级是静默的（UI 仍然可用，只是状态不落盘），必须显式告警。
      logger.warn('[lx-music-for-dsh] storage domain 打开失败，使用内存存储:', err)
      console.error('[lx-music-for-dsh] storage domain 打开失败，本次运行播放列表/设置不会持久化:', err)
      recordStatus({
        phase: 'storage-ready',
        storage: 'memory',
        domain: `打开失败: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
        stash: `${stashInfo}${restored ? '（已还原）' : ''}`,
      })
    }
  } else {
    console.error('[lx-music-for-dsh] storageDomain 服务不可用，本次运行播放列表/设置不会持久化')
    recordStatus({ phase: 'storage-ready', storage: 'memory', domain: 'storageDomain 服务不可用' })
  }

  // 音乐画像：store（持久化）+ recorder（捕获）+ facade（UI/Remote 读写）。
  // 默认开启，用户可在首启引导里关闭。
  // 抽成函数是因为存储可能**迟于本插件就绪**（见下面的兜底路径），两条路都要建同一套东西。
  const buildTaste = (
    store: StorageFace,
  ): { memory: ReturnType<typeof normalizeMemoryConfig>; tasteStore: TasteStore; recorder: TasteRecorder; facade: TasteFacade } => {
    const memory = normalizeMemoryConfig((store.global.get() as { memory?: unknown } | undefined)?.memory)
    const tasteStore = new TasteStore(store, {
      onWarn: (msg, err) => {
        logger.warn(msg, err)
      },
    })
    const recorder = new TasteRecorder({
      store: tasteStore,
      halfLifeDays: memory.halfLifeDays,
      exploreRatio: memory.exploreRatio,
      onWarn: (msg, err) => {
        logger.warn(msg, err)
      },
    })
    const facade = new TasteFacade({
      store: tasteStore,
      recorder,
      storage: store,
      memory,
      onMemoryChange: (next) => {
        // 配置热更新：半衰期/探索率立刻对捕获层生效（不必重启）
        recorder.halfLifeDays = next.halfLifeDays
        recorder.exploreRatio = next.exploreRatio
      },
      onWarn: (msg, err) => {
        logger.warn(msg, err)
      },
    })
    return { memory, tasteStore, recorder, facade }
  }

  let memory = normalizeMemoryConfig(undefined)
  let tasteStore: TasteStore | undefined
  let facade: TasteFacade | undefined
  if (storage) {
    const built = buildTaste(storage)
    memory = built.memory
    tasteStore = built.tasteStore
    facade = built.facade
  }

  // 播放服务（Typert Remote：lxPlayback）
  const service = new PlaybackService(ctx as never, {
    storage,
    settings,
    rateLimiter,
    ...(facade ? { taste: facade, tasteUi: facade } : {}),
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
        storage.table('logs').put(storageKey(entry.time), entry).catch((err) => logger.warn('[lx-music-for-dsh] 日志写入失败:', err))
      }
    },
  })

  // LLM 音乐工具集（细粒度：搜索/播放/播放列表/上下首/控制 + 兼容 search_and_play）
  const toolNames: string[] = []
  const toolCtx = { ...ctx, tools: { register: (tool: unknown) => { toolNames.push(String((tool as { name?: unknown })?.name ?? '?')); ctx.tools.register(tool) } } }
  registerMusicTools(toolCtx as never, { service })

  // 画像工具集（music_profile / music_play_song / music_taste）：
  // 有 storage 就注册（画像被关闭时工具会明确回"已关闭"，而不是让模型以为能力不存在）
  const logTo = (target: StorageFace | undefined, entry: { time: string }) => {
    target?.table('logs').put(storageKey(entry.time), entry).catch((err) => logger.warn('[lx-music-for-dsh] 日志写入失败:', err))
  }
  if (tasteStore) {
    registerTasteTools(toolCtx as never, {
      service,
      store: tasteStore,
      memory,
      onLog: (entry) => logTo(storage, entry),
    })
  }

  // 存储迟到就绪的兜底：`inject` 只声明了 tools，所以即使 apply 开始时 storageDomain 还没
  // 绑定（服务加载顺序/热重载都会造成），插件也**已经**可用（服务 + 音乐工具在内存模式下工作）。
  // 存储一旦可用，再把持久层与画像挂上去，不必重启插件。
  if (!storage && typeof ctx.inject === 'function') {
    ctx.inject(['storageDomain'], (scoped) => {
      const late = scoped.storageDomain
      if (!late) return
      void (async () => {
        let lateStorage: StorageFace | undefined
        try {
          const legacyPath = defaultDomainFile()
          const legacy = readLegacyWholeUnit(legacyPath)
          const needsMigration = migrateLegacy !== false && needsLegacyMigration(domainSpec.name)
          const stashed = needsMigration ? stashLegacyFile() : undefined
          const domain = (await late.open(domainSpec)) as Parameters<typeof adaptDomain>[0]
          lateStorage = adaptDomain(domain)
          if (migrateLegacy !== false && legacy) {
            await migrateLegacyDomain({ target: lateStorage, specTables: Object.keys(domainSpec.tables), legacyPath: stashed ?? legacyPath, legacy, warn: (m) => logger.warn(m) })
          }
          service.attachStorage(lateStorage)
          const built = buildTaste(lateStorage)
          service.attachTaste(built.facade, built.facade)
          registerTasteTools(toolCtx as never, { service, store: built.tasteStore, memory: built.memory, onLog: (entry) => logTo(lateStorage, entry) })
          recordStatus({ phase: 'ready', storage: 'durable', domain: 'ok（迟到挂载）', stash: stashed ? `已搁置 → ${stashed}` : '未触发', tools: toolNames })
        } catch (err) {
          logger.warn('[lx-music-for-dsh] 存储迟到挂载失败，继续以内存模式运行:', err)
          recordStatus({ phase: 'failed', storage: 'memory', error: `迟到挂载失败: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`, tools: toolNames })
        }
      })()
    })
  }

  // 插件自带的 skill：把"先查画像 → 精确播放"的流程随插件版本一起发布。
  // 用作用域注入（而不是写进 inject 数组）：skill 服务在旧版/精简宿主里可能不存在，
  // 写进 inject 会让整个插件拒绝激活，而作用域注入只在该服务可用时才跑回调。
  ctx.inject?.(['skills'], (scoped) => {
    try {
      scoped.skills?.register(TASTE_SKILL)
      console.info(`[lx-music-for-dsh] 已注册 skill: ${TASTE_SKILL_NAME}`)
    } catch (err) {
      logger.warn('[lx-music-for-dsh] skill 注册失败（不影响其它功能）:', err)
    }
  })

  // 插件卸载时释放音源子进程（避免孤儿进程）并结算当前画像会话
  const disposeHook = (ctx as { on?: (event: string, fn: () => void) => void }).on
  disposeHook?.('dispose', () => {
    facade?.flush()
    service.disposeProvider()
  })

  // ctx.logger 的去向由宿主决定（可能被日志级别过滤），启动行同时写 stdout，
  // 便于按 docs/development.md §4.1 在启动 dsh 的终端直接确认插件是否加载。
  const status = `[lx-music-for-dsh] 插件已加载，provider: ${service.getProviderMode()}，storage: ${storage ? 'durable' : 'memory'}，工具: ${toolNames.length}`
  logger.warn(status)
  console.info(status)
  recordStatus({ phase: 'ready', storage: storage ? 'durable' : 'memory', tools: toolNames })
}
