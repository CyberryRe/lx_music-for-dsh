import { existsSync, readFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { StorageFace } from '../playback'
import { storageKey } from './keys'

/**
 * 旧版（1.1.0 及更早）storage domain 的落盘文件：`$DSH_HOME/storages/lx_music.json`。
 *
 * 1.2.0 把 domain 从 `single` 换成 `per-record`（写放大 + 坏记录韧性，见
 * docs/design-taste-memory.md §2/§13）。**不能依赖 JSON backend 的 "legacy bootstrap"**：
 *   1. 它只播种**表记录**、**不带 `global`**，而播放列表/当前索引/音质/音量/静音/播放模式/
 *      设置全在 global 里；
 *   2. 它把**旧文件的原始键直接当文件名**（`join(dir, table, `${key}.json`)`，不做转义），
 *      而 `logs` 表的键是 ISO 时间戳（`2026-09-11T03:47:40.052Z`）——**Windows 文件名不允许冒号**，
 *      于是 bootstrap 以 `ENOENT: rename '….tmp' -> '…2026-09-11T03:47:40.052Z.json'` 失败，
 *      整个 `open()` 抛错、插件静默退化成内存存储（1.2.0 在桌面版实测踩到）。
 *
 * 因此改成"自己读 → 把旧文件改名搁置 → 再打开"：旧文件不在原路径，bootstrap 就不会触发，
 * 迁移完全由本模块显式完成（键统一过 `storageKey()`）。
 */
export function defaultDomainFile(source: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = source.DSH_HOME
  const home = fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.dsh')
  return join(home, 'storages', 'lx_music.json')
}

/** per-record 布局的目录（backend 以 domain 名做目录名）。 */
export function perRecordDir(domainName: string, source: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(defaultDomainFile(source)), domainName)
}

/** 是否需要一次性迁移：per-record 目录还没建，但旧整份文件在。 */
export function needsLegacyMigration(domainName: string, source: NodeJS.ProcessEnv = process.env): boolean {
  return !existsSync(perRecordDir(domainName, source)) && existsSync(defaultDomainFile(source))
}

/**
 * 把旧整份文件改名搁置（`.migrated-<时间戳>`，与音源文件迁移同一约定），返回新路径。
 * 目的是让 backend 的 bootstrap 不触发；改名失败返回 undefined（调用方照常继续，只是迁移会跳过）。
 */
export function stashLegacyFile(source: NodeJS.ProcessEnv = process.env): string | undefined {
  const file = defaultDomainFile(source)
  if (!existsSync(file)) return undefined
  const target = `${file}.migrated-${Date.now()}`
  try {
    renameSync(file, target)
    return target
  } catch {
    return undefined
  }
}

/** 还原搁置的旧文件（打开失败时回滚，保证用户数据始终在原位、旧版本仍能读回）。 */
export function restoreLegacyFile(stashed: string | undefined, source: NodeJS.ProcessEnv = process.env): boolean {
  if (!stashed) return false
  try {
    renameSync(stashed, defaultDomainFile(source))
    return true
  } catch {
    return false
  }
}

/** 旧版整份文件的形状：`{ unit: { name, version }, global: {...}|null, tables: { <表>: { <键>: 值 } } }`。 */
export interface LegacyWholeUnit {
  unitVersion?: number
  global?: unknown
  tables: Record<string, Record<string, unknown>>
}

/**
 * 读取旧版整份文件。不存在 / 不可读 / 不是合法 JSON / 形状不符 → `undefined`
 * （等价于"无需迁移"，不能让迁移失败阻断插件加载）。
 */
export function readLegacyWholeUnit(file: string): LegacyWholeUnit | undefined {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
  let doc: unknown
  try {
    doc = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return undefined
  const record = doc as { unit?: unknown; global?: unknown; tables?: unknown }
  const tables: Record<string, Record<string, unknown>> = {}
  if (record.tables && typeof record.tables === 'object' && !Array.isArray(record.tables)) {
    for (const [name, rows] of Object.entries(record.tables as Record<string, unknown>)) {
      if (rows && typeof rows === 'object' && !Array.isArray(rows)) {
        tables[name] = rows as Record<string, unknown>
      }
    }
  }
  const unitVersion =
    record.unit && typeof record.unit === 'object' && typeof (record.unit as { version?: unknown }).version === 'number'
      ? ((record.unit as { version: number }).version)
      : undefined
  return { ...(unitVersion === undefined ? {} : { unitVersion }), global: record.global ?? undefined, tables }
}

export type MigrationReason = 'already-migrated' | 'no-legacy-file' | 'done' | 'failed'

export interface MigrationResult {
  migrated: boolean
  reason: MigrationReason
  /** 实际写入的表记录条数（按表名统计）。 */
  tables?: Record<string, number>
  globalMigrated?: boolean
  /** global 迁移采用的来源：legacy = 整体采用旧值；merged = 新值优先、旧值补缺；none = 旧文件没有 global。 */
  globalSource?: 'legacy' | 'merged' | 'none'
  error?: string
}

export interface MigrationOptions {
  target: StorageFace
  /** 新 domain 声明了哪些表（旧文件里多出来的表会被忽略）。 */
  specTables: readonly string[]
  /** 旧文件路径（仅用于日志与兜底读取）。 */
  legacyPath: string
  /** 已经读出来的旧数据（index.ts 在打开 domain 之前就读好了，避免 backend bootstrap 抢跑）。 */
  legacy?: LegacyWholeUnit
  now?: () => number
  log?: (message: string) => void
  warn?: (message: string) => void
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function readMemory(global: unknown): Record<string, unknown> | undefined {
  if (!global || typeof global !== 'object') return undefined
  const memory = (global as { memory?: unknown }).memory
  return memory && typeof memory === 'object' ? (memory as Record<string, unknown>) : undefined
}

/**
 * 判断新 domain 的 global 是否"从未被真正使用过"。
 *
 * `global.get()` 在没有落盘记录时返回 spec 的 `initial`，因此无法直接区分"没写过"和
 * "写过但恰好等于默认值"；这里用"播放列表为空且当前索引为 -1"作为近似判据：
 * 只有这种情况才整体采用旧值，否则新值优先（避免把升级后新写入的状态回退成旧状态）。
 */
function looksFresh(global: unknown): boolean {
  if (!global || typeof global !== 'object') return true
  const value = global as { playlist?: unknown; currentIndex?: unknown }
  const playlistEmpty = !Array.isArray(value.playlist) || value.playlist.length === 0
  const indexFresh = typeof value.currentIndex !== 'number' || value.currentIndex < 0
  return playlistEmpty && indexFresh
}

/**
 * 把旧版 `single` 布局的数据一次性迁移进新的 `per-record` domain。
 *
 * 顺序刻意是"先表、后 global"：幂等标记写在 global 上，因此**只有 global 写入成功
 * 才算迁移完成**；中途失败时标记不存在，下次启动会自动重试（表记录用的是按键覆盖写，
 * 重复执行是幂等的）。旧文件不会被本模块修改或删除。
 */
export async function migrateLegacyDomain(options: MigrationOptions): Promise<MigrationResult> {
  const log = options.log ?? ((): void => {})
  const warn = options.warn ?? ((): void => {})
  const now = options.now ?? Date.now

  const current = options.target.global.get()
  const currentMemory = readMemory(current)
  if (typeof currentMemory?.migratedFrom === 'string' && currentMemory.migratedFrom) {
    return { migrated: false, reason: 'already-migrated' }
  }

  const legacy = options.legacy ?? readLegacyWholeUnit(options.legacyPath)
  if (!legacy) return { migrated: false, reason: 'no-legacy-file' }

  // 1) 表记录：按键覆盖写，天然幂等
  const counts: Record<string, number> = {}
  try {
    for (const name of options.specTables) {
      const rows = legacy.tables[name]
      if (!rows) continue
      const table = options.target.table(name)
      let written = 0
      for (const [key, value] of Object.entries(rows)) {
        // 旧文件的键直接当文件名会踩 Windows 非法字符（ISO 时间戳里的冒号），必须转义
        await table.put(storageKey(key), value)
        written += 1
      }
      if (written > 0) counts[name] = written
    }
  } catch (err) {
    // 未写标记 → 下次启动重试；不能让迁移失败阻断插件加载
    warn(`[lx-music-for-dsh] 旧存储迁移：表记录写入失败，下次启动会重试: ${message(err)}`)
    return { migrated: false, reason: 'failed', error: message(err) }
  }

  // 2) global（含幂等标记）：最后写，成功即视为迁移完成
  const hasLegacyGlobal = legacy.global !== undefined && legacy.global !== null
  let globalMigrated: boolean
  let globalSource: MigrationResult['globalSource'] = 'none'
  try {
    const legacyGlobal = hasLegacyGlobal && typeof legacy.global === 'object' ? (legacy.global as Record<string, unknown>) : {}
    let base: Record<string, unknown>
    if (!hasLegacyGlobal) {
      base = current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {}
    } else if (looksFresh(current)) {
      base = { ...legacyGlobal }
      globalSource = 'legacy'
    } else {
      // 新值优先、旧值补缺（升级后已经被写过状态时的安全合并）
      base = { ...legacyGlobal, ...(current as Record<string, unknown>) }
      globalSource = 'merged'
    }
    const next = {
      ...base,
      memory: {
        ...(currentMemory ?? {}),
        migratedFrom: `single@${new Date(now()).toISOString()}`,
      },
    }
    await options.target.global.set(next)
    globalMigrated = true
  } catch (err) {
    warn(`[lx-music-for-dsh] 旧存储迁移：global 写入失败（播放列表/设置将使用默认值）: ${message(err)}`)
    return { migrated: true, reason: 'done', tables: counts, globalMigrated: false, globalSource, error: message(err) }
  }

  const tableSummary = Object.entries(counts)
    .map(([name, n]) => `${name}=${n}`)
    .join(', ')
  log(
    `[lx-music-for-dsh] 旧存储已迁移到 per-record 布局：${tableSummary || '无表记录'}，global=${globalSource}` +
      `${legacy.unitVersion === undefined ? '' : `（旧 unit version=${legacy.unitVersion}）`}`,
  )
  return { migrated: true, reason: 'done', tables: counts, globalMigrated, globalSource }
}
