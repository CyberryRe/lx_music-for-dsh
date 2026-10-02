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
import { cancelPendingCleanup, scheduleCleanup } from './storage/cleanup'
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
  // 卸载插件时清理本机留下的数据（播放列表 / 画像 / 点歌日志 / 音源）。
  // **默认 false**：cordis 分不清「退出应用」与「卸载插件」，自动删除可能在慢退出时误删用户数据；
  // 显式开启后是「延迟 30s + 期间重新激活即取消」（见 storage/cleanup.ts）。
  cleanupOnUninstall: z.boolean().default(false),
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

/**
 * 激活失败时附带的用户提示。
 *
 * DSH 插件页会把激活失败的原因显示在报错栏里；**只有我们自己抛的错**能带这段文字
 * （cordis 代理抛的 `without inject`、配置校验错等在 apply 之前发生，改不了 —— 那种情况
 * 由插件列表里的 description 与客户端卡片的提示兜底）。
 */
const ACTIVATION_HINT =
  '\n\n提示：本版本安装/更新后需要**彻底退出并重启 DSH**（关窗口不算）才会加载新代码。' +
  '若你刚更新过插件，请完全退出 DSH 后重新打开；该问题会在下个大版本修复。' +
  '（排查入口：$DSH_HOME/lx-music-plugin-status.json 记录了激活的每个阶段）'

/** 导出入口：包一层，保证激活失败既有状态记录、又带用户可读提示。 */
export async function apply(ctx: Parameters<typeof applyInner>[0], rawConfig: Record<string, unknown>): Promise<void> {
  try {
    return await applyInner(ctx, rawConfig)
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    recordStatus({ phase: 'failed', error: `apply 抛错: ${detail}` })
    throw err instanceof Error ? new Error(`${err.message}${ACTIVATION_HINT}`) : new Error(String(err) + ACTIVATION_HINT)
  }
}

// 进程级共享的存储句柄与进行中的 open。
// 为什么是模块级：同一次进程里 `apply` 可能跑多次，而 storage domain **同名只能打开一次**
// （第二次 open 抛 `domain 'lx_music' is already open`）；不复用就会整场降级为内存模式，
// 表现为"重启 DSH 后刚导入的音源不见了"。
let processStorage: StorageFace | undefined
let openingStorage: Promise<StorageFace | undefined> | undefined

/**
 * 清掉进程级存储句柄（**仅测试用**，以及需要重新绑定另一个 storageDomain 的嵌入方）。
 *
 * 为什么需要这个缝：`processStorage` 是进程级单例，所以同一进程里第二次 `apply` 会**复用**
 * 第一次打开的 domain（这是刻意的——重复 `open` 会抛 `already open`）。但这也意味着
 * "第二次 apply 的 storageDomain 是被忽略的"：如果它其实指向另一份存储（测试里的假 domain、
 * 或嵌入方换绑），写进去的数据会落到第一份上。
 * 单测在同一进程里连续 `apply` 多次，必须能显式重置，否则会串味（tests/host.integration.test.ts
 * 实测：第二个用例的假 domain 永远收不到日志）。
 */
export function resetProcessStorageForTests(): void {
  processStorage = undefined
  openingStorage = undefined
}

async function applyInner(ctx: {
  tools: { register(tool: unknown): void }
  /** 可选注入钩子：storage/skill 服务都可能不存在，**只能**用它拿（不能直接读 ctx.xxx）。 */
  inject?: (deps: string[], fn: (scoped: { skills?: { register(skill: unknown): () => void }; storageDomain?: { open(spec: unknown): Promise<unknown> } }) => void) => unknown
  logger?: { warn(...args: unknown[]): void }
}, rawConfig: Record<string, unknown>): Promise<void> {
  // ⚠️ 这里**绝不能**读 `ctx.storageDomain` / `ctx.skills`：
  // cordis 4 的 context 代理只允许读「inject 已声明」或「本 fiber 已 provide」的服务，
  // 否则直接抛 `cannot get property "storageDomain" without inject`
  // （1.2.1 在 DSH 0.2.0-rc.2 上的翻车点，见 docs/development.md §4.1.1）。
  // 可选能力一律走作用域注入 `ctx.inject([...], cb)`。
  // 重新激活（升级 / 热重载）→ 取消上一次卸载留下的待清理，避免升级把用户数据删掉
  cancelPendingCleanup()
  const canInject = typeof ctx.inject === 'function'
  recordStatus({
    phase: 'enter',
    services: { tools: Boolean(ctx.tools), inject: canInject },
    storage: 'pending',
  })

  const settings = toSettings(rawConfig)
  const logger = ctx.logger ?? console
  // 迁移开关：默认开；只有显式 false / 'false' 才关闭（YAML 行配置可能给字符串）
  const migrateLegacy = !(rawConfig.migrateLegacyDomain === false || rawConfig.migrateLegacyDomain === 'false')
  // 卸载清理开关：**默认关**（显式开启才生效）。
  // 原因：正常退出 DSH 同样会触发 dispose，而「退出」与「卸载」在 cordis 里不可区分；
  // 只要有慢退出（超过延迟）就可能把用户数据整个删掉。所以默认不动用户数据；
  // 需要「卸载即清理」的人显式写 cleanupOnUninstall: true，
  // 想立刻清理随时可用「设置 → 实验性 → 清理本机数据」。
  const cleanupOnUninstall = rawConfig.cleanupOnUninstall === true || rawConfig.cleanupOnUninstall === 'true'

  // 限流器（LLM 点歌防刷）
  const rateLimiter = new SlidingWindowRateLimiter({
    maxCalls: settings.rateLimitPerMinute,
    windowMs: 60_000,
  })

  // 存储与音乐画像：**只能**通过作用域注入获得（见文件末尾的 ctx.inject(['storageDomain'])）。
  // 三条历史教训都写在这里，避免再走回头路：
  //   1. storageDomain 写进 `inject`（=必需依赖）→ 服务没就绪时 cordis 根本不调用 apply，
  //      服务/工具全都不存在，客户端 `lxPlayback/*` 一律 404（1.2.0 的事故）；
  //   2. 直接读 `ctx.storageDomain` → cordis 4 的代理只允许读已声明/已 provide 的服务，
  //      否则抛 `cannot get property "storageDomain" without inject`（1.2.1 在 0.2.0 的事故）；
  //   3. 存储打开失败必须降级为内存模式而不是让插件消失（代码里所有分支都保证这一点）。
  let storage: StorageFace | undefined
  let memory = normalizeMemoryConfig(undefined)
  let tasteStore: TasteStore | undefined
  let facade: TasteFacade | undefined

  // 音乐画像三件套（store/recorder/facade）：依赖存储，因此与存储挂载绑定在一起。
  const buildTaste = (
    store: StorageFace,
  ): { memory: ReturnType<typeof normalizeMemoryConfig>; tasteStore: TasteStore; recorder: TasteRecorder; facade: TasteFacade } => {
    const resolved = normalizeMemoryConfig((store.global.get() as { memory?: unknown } | undefined)?.memory)
    const builtStore = new TasteStore(store, {
      onWarn: (msg, err) => {
        logger.warn(msg, err)
      },
    })
    const recorder = new TasteRecorder({
      store: builtStore,
      halfLifeDays: resolved.halfLifeDays,
      exploreRatio: resolved.exploreRatio,
      onWarn: (msg, err) => {
        logger.warn(msg, err)
      },
    })
    const builtFacade = new TasteFacade({
      store: builtStore,
      recorder,
      storage: store,
      memory: resolved,
      onMemoryChange: (next) => {
        // 配置热更新：半衰期/探索率立刻对捕获层生效（不必重启）；skill 与日志门控跟着开关走。
        // ⚠️ 必须把 next 写回 apply 作用域的 memory —— logTo（点歌日志门控）读的就是它，
        // 否则"刚开启却仍然不写日志 / 刚关闭却还在写"。
        memory = next
        recorder.halfLifeDays = next.halfLifeDays
        recorder.exploreRatio = next.exploreRatio
        syncSkill(next.enabled)
      },
      onWarn: (msg, err) => {
        logger.warn(msg, err)
      },
    })
    return { memory: resolved, tasteStore: builtStore, recorder, facade: builtFacade }
  }

  // 工具名收集（状态文件里记录，便于确认注册是否完整）。
  const toolNames: string[] = []
  const toolCtx = {
    ...ctx,
    tools: {
      register: (tool: unknown) => {
        toolNames.push(String((tool as { name?: unknown })?.name ?? '?'))
        ctx.tools.register(tool)
      },
    },
  }
  /**
   * 写点歌/播放行为日志（logs 表）。
   *
   * ⚠️ **跟着实验性开关走**：用户明确要求"没开就不记录任何音乐行为"，而 logs 表里正是
   * play / next / prev / search 这些行为记录，所以关闭时一条都不写（存储里的历史记录保留，
   * 用户可在设置窗口的日志页查看旧记录，或清空存储）。
   */
  const logTo = (target: StorageFace | undefined, entry: unknown): void => {
    if (!memory.enabled) return
    const row = entry as { time: string }
    target?.table('logs').put(storageKey(row.time), entry).catch((err) => logger.warn('[lx-music-for-dsh] 日志写入失败:', err))
  }

  // 播放服务（Typert Remote：lxPlayback）。**不依赖存储**：先注册，存储就绪后再 attach。
  // onWarn 走宿主 logger（桌面版没有终端，console 输出看不到）。
  const service = new PlaybackService(ctx as never, {
    settings,
    rateLimiter,
    onWarn: (message, error) => logger.warn(message, error),
    onSettingsChange: (s) => {
      // rateLimitPerMinute 变更 → 重建限流器
      if (s.rateLimitPerMinute !== settings.rateLimitPerMinute) {
        rateLimiter.reset()
        rateLimiter.setMaxCalls(s.rateLimitPerMinute)
        settings.rateLimitPerMinute = s.rateLimitPerMinute
      }
    },
    onLog: (entry) => logTo(storage, entry),
  })

  // LLM 音乐工具集（细粒度：搜索/播放/播放列表/上下首/控制 + 兼容 search_and_play）
  registerMusicTools(toolCtx as never, { service })

  /**
   * 打开 domain 并按需做一次性迁移（不碰服务）。
   *
   * 迁移顺序：**先读旧数据 → 旧文件改名搁置 → 打开 → 显式迁移**。
   * 为什么不能只靠 backend 的 legacy bootstrap：它只用旧文件的原始键当文件名（Windows 上
   * ISO 时间戳里的冒号非法 → ENOENT → 整个 open 失败，插件静默退化成内存），而且不带 global。
   *
   * ⚠️ **进程级复用**：同一次进程里 `apply` 可能被调用多次（热重载 / 多行加载 / 上一次的 fiber
   * 还没释放），第二次再 `open` 会以
   * `DomainError: domain 'lx_music' is already open` 失败 → 整场降级为内存模式 →
   * 用户看到的是"刚导入的音源重启后不见了"（1.2.2 实测事故）。
   * 所以：能复用就复用同一个 StorageFace；真的撞上 already open 也有界重试。
   */
  const openStorage = async (domain: { open(spec: unknown): Promise<unknown> }): Promise<boolean> => {
    // 1) 本进程已经开好 → 直接复用（不重复 open、不重复迁移）
    if (processStorage) {
      storage = processStorage
      recordStatus({ phase: 'storage-ready', storage: 'durable', domain: '复用本进程已打开的 domain' })
      return true
    }
    // 2) 另一个 apply 正在开 → 等它（并发去重）
    if (openingStorage) {
      const shared = await openingStorage
      if (shared) {
        storage = shared
        recordStatus({ phase: 'storage-ready', storage: 'durable', domain: '等待并发 open 后复用' })
        return true
      }
    }
    const legacyPath = defaultDomainFile()
    const legacy = readLegacyWholeUnit(legacyPath)
    const needsMigration = migrateLegacy && needsLegacyMigration(domainSpec.name)
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
      // 有界重试：撞上 "already open" 时给旧 fiber 一点释放时间（常见于重启/热重载）
      let opened: Parameters<typeof adaptDomain>[0] | undefined
      let lastError: unknown
      const attempt = async (): Promise<void> => {
        for (let i = 1; i <= 4; i++) {
          try {
            opened = (await domain.open(domainSpec)) as Parameters<typeof adaptDomain>[0]
            return
          } catch (err) {
            lastError = err
            const message = err instanceof Error ? err.message : String(err)
            if (!/already open/i.test(message) || i === 4) throw err
            logger.warn(`[lx-music-for-dsh] storage domain 已被占用，${i * 300}ms 后重试（第 ${i} 次）：${message}`)
            await new Promise((r) => setTimeout(r, i * 300))
          }
        }
      }
      const opening = attempt()
      openingStorage = opening.then(() => processStorage ?? undefined)
      await opening
      openingStorage = undefined
      if (!opened) throw lastError ?? new Error('domain 打开失败')
      const store = adaptDomain(opened)
      processStorage = store
      let migrationInfo = '无旧数据'
      if (migrateLegacy && legacy) {
        const result = await migrateLegacyDomain({
          target: store,
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
      storage = store
      recordStatus({ phase: 'storage-ready', storage: 'durable', domain: 'ok', stash: stashInfo, migration: migrationInfo })
      return true
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
      return false
    }
  }

  let tasteToolsRegistered = false
  const attachStorageAndTaste = (): void => {
    if (!storage) return
    service.attachStorage(storage)
    const built = buildTaste(storage)
    memory = built.memory
    tasteStore = built.tasteStore
    facade = built.facade
    syncSkill(memory.enabled)
    service.attachTaste(built.facade, built.facade)
    if (!tasteToolsRegistered) {
      registerTasteTools(toolCtx as never, {
        service,
        store: built.tasteStore,
        memory: built.memory,
        onLog: (entry) => logTo(storage, entry),
      })
      tasteToolsRegistered = true
    }
  }

  // 存储的**唯一**入口：作用域注入。
  // 已就绪 → 同步回调；稍后就绪（加载顺序/热重载）→ 回调仍会触发。启动时若拿不到，
  // 插件已经在内存模式下可用（服务 + 音乐工具都在），这正是 1.2.0 缺的那一环。
  ctx.inject?.(['storageDomain'], (scoped) => {
    const domain = scoped.storageDomain
    if (!domain) return
    void openStorage(domain)
      .then((ok) => {
        if (!ok || !storage) return
        attachStorageAndTaste()
        // 音源持久化后端必须能被确认：durable=storage domain（重启不丢），
        // file=兜底文件。历史事故（provider 早于 storage 建好、之后没重建）会让音源
        // 只进兜底文件，这里把它变成一行可核对的记录。
        const storeKind = service.providerStoreKind()
        const status = `[lx-music-for-dsh] 存储已就绪，provider: ${service.getProviderMode()}（音源存储: ${storeKind}），工具: ${toolNames.length}`
        logger.warn(status)
        console.info(status)
        recordStatus({ phase: 'ready', storage: 'durable', domain: '已挂载存储与画像', sourceStore: storeKind, tools: toolNames })
      })
      .catch((err) => {
        logger.warn('[lx-music-for-dsh] 存储挂载失败，继续以内存模式运行:', err)
        recordStatus({
          phase: 'failed',
          storage: 'memory',
          error: `挂载失败: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
          tools: toolNames,
        })
      })
  })

  // 插件自带的 skill：把"先查画像 → 精确播放"的流程随插件版本一起发布。
  // 用作用域注入（而不是写进 inject 数组）：skill 服务在旧版/精简宿主里可能不存在，
  // 写进 inject 会让整个插件拒绝激活，而作用域注入只在该服务可用时才跑回调。
  //
  // ⚠️ skill **跟着画像开关走**：画像是实验性功能且默认关闭，此时不该让模型以为有这套能力
  // （否则它会去调 music_profile 然后拿到"已关闭"）。开启/关闭即时生效，无需重启。
  let skillsService: { register(skill: unknown): () => void } | undefined
  let skillDisposer: (() => void) | undefined
  const syncSkill = (enabled: boolean): void => {
    if (!skillsService) return
    try {
      if (enabled && !skillDisposer) {
        skillDisposer = skillsService.register(TASTE_SKILL)
        console.info(`[lx-music-for-dsh] 已注册 skill: ${TASTE_SKILL_NAME}（画像已开启）`)
      } else if (!enabled && skillDisposer) {
        skillDisposer()
        skillDisposer = undefined
        console.info(`[lx-music-for-dsh] 画像已关闭，撤下 skill: ${TASTE_SKILL_NAME}`)
      }
    } catch (err) {
      logger.warn('[lx-music-for-dsh] skill 注册失败（不影响其它功能）:', err)
    }
  }
  ctx.inject?.(['skills'], (scoped) => {
    skillsService = scoped.skills
    syncSkill(memory.enabled)
  })

  // 插件卸载时释放音源子进程（避免孤儿进程）、结算当前画像会话，并按配置**清理本地数据**。
  //
  // ⚠️ 清理是「延迟 + 可取消」的：DSH 升级插件同样是"卸载旧包 → 安装新包"，都会触发 dispose。
  // 立刻删会让用户每次升级都丢播放列表与画像，所以延迟 8 秒，只要期间插件重新激活就取消
  // （apply 开头调用 cancelPendingCleanup）。
  const disposeHook = (ctx as { on?: (event: string, fn: () => void) => void }).on
  disposeHook?.('dispose', () => {
    facade?.flush()
    service.disposeProvider()
    if (!cleanupOnUninstall) return
    scheduleCleanup({
      onDone: (result) => {
        // 状态文件此时已被删除，只能写 stdout / ctx.logger
        const msg = `[lx-music-for-dsh] 卸载清理：删除 ${result.removed.length} 项本地数据${
          result.failed.length > 0 ? `，${result.failed.length} 项失败（${result.failed.map((f) => f.path).join(', ')}）` : ''
        }`
        logger.warn(msg)
        console.info(msg)
      },
    })
  })

  // ctx.logger 的去向由宿主决定（可能被日志级别过滤），启动行同时写 stdout，
  // 便于按 docs/development.md §4.1 在启动 dsh 的终端直接确认插件是否加载。
  const tasteState = !tasteStore ? '未挂载' : memory.enabled ? '开' : '关（实验性功能默认关闭）'
  const status = `[lx-music-for-dsh] 插件已加载，provider: ${service.getProviderMode()}（音源存储: ${service.providerStoreKind()}），storage: ${storage ? 'durable' : 'pending/memory'}，画像: ${tasteState}，工具: ${toolNames.length}`
  logger.warn(status)
  console.info(status)
  recordStatus({ phase: 'ready', storage: storage ? 'durable' : 'memory', sourceStore: service.providerStoreKind(), tools: toolNames })
}