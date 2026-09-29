// 本地数据清理。
//
// 两处用到：
//   1. 用户在设置里点「彻底清除本地数据」——立即清空画像 + 播放列表 + 点歌日志 + 遗留文件；
//   2. 插件被**卸载**时（`dispose`）按配置自动清理（默认开）。
//
// 为什么卸载清理要"延迟 + 可取消"：
//   DSH 升级插件同样是"卸载旧包 → 安装新包"，两者都会触发 `dispose`。若无脑立刻删，
//   用户每次升级都会丢掉播放列表与画像。所以卸载时**延迟**删除，并在延迟窗口内只要插件
//   重新激活（= 升级/热重载）就**取消**删除。代价是"卸载后若进程立刻退出"则删除不发生
//   （宁可留下数据，也不冒升级丢数据的风险）；用户想要立即干净可以在卸载前点设置里的按钮。

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** 一次清理的结果（用于日志/UI 反馈）。 */
export interface CleanupResult {
  /** 已删除的路径。 */
  removed: string[]
  /** 删除失败的路径与原因（权限/占用等）。 */
  failed: Array<{ path: string; error: string }>
}

function dshHome(source: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = source.DSH_HOME
  return fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.dsh')
}

/** 本插件在本地写入过的所有路径（存在的才会被返回）。 */
export function localDataPaths(source: NodeJS.ProcessEnv = process.env): string[] {
  const home = dshHome(source)
  const storages = join(home, 'storages')
  const paths: string[] = []

  // 1) per-record domain 目录（播放列表/设置/画像/日志/音源都在里面）
  const domainDir = join(storages, 'lx_music')
  if (existsSync(domainDir)) paths.push(domainDir)

  // 2) 旧版单文件与它的搁置副本、音源文件兜底与它的迁移副本
  for (const prefix of ['lx_music.json', 'lx-music-sources.json']) {
    const exact = join(storages, prefix)
    if (existsSync(exact)) paths.push(exact)
    let entries: string[]
    try {
      entries = readdirSync(storages)
    } catch {
      entries = []
    }
    for (const name of entries) {
      if (name.startsWith(`${prefix}.`) && name.length > prefix.length + 1) paths.push(join(storages, name))
    }
  }

  // 3) 插件自诊断状态文件
  const status = join(home, 'lx-music-plugin-status.json')
  if (existsSync(status)) paths.push(status)

  return paths
}

/**
 * 删除本插件留在本机的数据。幂等：不存在就跳过。
 *
 * @param options.source - 环境变量来源（测试注入用）。
 * @param options.includeDomain - 是否连 storage domain 目录一起删（默认 true）。
 *   插件运行期间该目录被 storage domain 打开着，此时只能传 false 删「域外遗留」
 *   （旧版整份文件、音源兜底文件、插件状态文件）。
 */
export function cleanupLocalData(options: { source?: NodeJS.ProcessEnv; includeDomain?: boolean } = {}): CleanupResult {
  const source = options.source ?? process.env
  const domainDir = join(dshHome(source), 'storages', 'lx_music')
  const result: CleanupResult = { removed: [], failed: [] }
  for (const path of localDataPaths(source)) {
    // domain 目录正被打开时不能删（UI 的「彻底清除」走这条路，只清域外遗留）
    if (options.includeDomain === false && path === domainDir) continue
    try {
      // 目录优先（rmSync recursive 也能删文件，但显式区分便于日志）
      const stat = statSync(path)
      rmSync(path, { recursive: stat.isDirectory(), force: true, maxRetries: 3 })
      result.removed.push(path)
    } catch (err) {
      result.failed.push({ path, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return result
}

// ── 卸载时的延迟清理 ───────────────────────────────────────────────────────

let pending: ReturnType<typeof setTimeout> | undefined

/** 默认延迟：足够覆盖"升级/热重载"的重新激活窗口。 */
export const UNINSTALL_CLEANUP_DELAY_MS = 8000

/**
 * 安排一次延迟清理（卸载时调用）。窗口内调用 {@link cancelPendingCleanup} 会取消。
 *
 * @param options.delayMs - 延迟毫秒（测试用）。
 * @param options.onDone - 删除后的回调（记录日志用；此时状态文件已被删，不要再写它）。
 */
export function scheduleCleanup(options: { delayMs?: number; onDone?: (result: CleanupResult) => void } = {}): void {
  cancelPendingCleanup()
  const delay = options.delayMs ?? UNINSTALL_CLEANUP_DELAY_MS
  pending = setTimeout(() => {
    pending = undefined
    const result = cleanupLocalData()
    options.onDone?.(result)
  }, delay)
  // 不要因为这个定时器把进程吊住
  pending.unref?.()
}

/** 取消待执行的清理（插件重新激活 = 升级/热重载时调用）。 */
export function cancelPendingCleanup(): boolean {
  if (pending === undefined) return false
  clearTimeout(pending)
  pending = undefined
  return true
}

/** 是否有待执行的清理（测试/诊断用）。 */
export function hasPendingCleanup(): boolean {
  return pending !== undefined
}
