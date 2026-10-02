// 插件自诊断状态文件。
//
// 为什么需要它：桌面版（Electron 宿主）里插件的 console 输出**看不到**（打包应用没有终端），
// 一旦 host 半边没激活、或存储被静默降级，外部只能靠"副作用有没有出现"来猜——
// 1.2.0 实测就吃了这个亏（`lxPlayback/*` 全 404、`storages/lx_music/` 一直不出现，无从判断）。
//
// 于是把激活过程落成一个**不依赖任何服务**的小文件：
//   $DSH_HOME/lx-music-plugin-status.json
// 它由 `apply()` 在进入时就开始写（此时连 storage 都还没打开），因此：
//   - 文件存在      → 插件 host 半边确实被激活了（附各阶段结果）；
//   - 文件不存在    → 插件根本没被调用（loader/依赖问题），排除法直接定位。
// 写入失败一律吞掉：诊断不能反过来影响插件本身。

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** 插件版本：必须与 package.json 一致（tests/activation.test.ts 锁住）。 */
export const PLUGIN_VERSION = '1.2.3'

/** 状态文件里的一次激活记录（同一进程内多次调用会保留历史，便于观察重试/热重载）。 */
export interface PluginStatusRecord {
  at: string
  pid: number
  phase: 'enter' | 'music-ready' | 'storage-ready' | 'ready' | 'failed'
  /** 关键服务在进入 apply 时是否可见（用于区分"依赖没就绪"与"代码出错"）。 */
  services?: Record<string, boolean>
  /** durable=已挂载存储；memory=存储不可用；pending=还没走到。 */
  storage?: 'durable' | 'memory' | 'pending'
  /** 域打开结果。 */
  domain?: string
  /** 旧文件搁置结果（路径 / 未触发的原因）。 */
  stash?: string
  /** 迁移结果摘要。 */
  migration?: string
  /** 已注册的工具名（分两批：music_* 与画像工具）。 */
  tools?: string[]
  /**
   * 音源落盘后端：domain=storage domain（重启不丢）；file=兜底文件
   * （`$DSH_HOME/storages/lx-music-sources.json`）；memory=不落盘。
   * 用于排查"加了音源、重启后不见了"。
   */
  sourceStore?: string
  /** 失败原因（含栈）。 */
  error?: string
}

interface StatusFile {
  plugin: string
  statusVersion: number
  updatedAt: string
  history: PluginStatusRecord[]
}

export function statusFilePath(source: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = source.DSH_HOME
  const home = fromEnv && fromEnv.trim() ? fromEnv.trim() : join(homedir(), '.dsh')
  return join(home, 'lx-music-plugin-status.json')
}

const MAX_HISTORY = 12

/** 记录一次激活状态（读-改-写；任何失败都静默）。 */
export function recordStatus(patch: Omit<PluginStatusRecord, 'at' | 'pid'>): void {
  try {
    const file = statusFilePath()
    let history: PluginStatusRecord[] = []
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as StatusFile
      if (Array.isArray(parsed?.history)) history = parsed.history
    } catch {
      // 首次写入 / 文件损坏：从头开始
    }
    const record: PluginStatusRecord = { at: new Date().toISOString(), pid: process.pid, ...patch }
    history.push(record)
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY)
    const payload: StatusFile = {
      plugin: `lx-music-for-dsh@${PLUGIN_VERSION}`,
      statusVersion: 1,
      updatedAt: record.at,
      history,
    }
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    // 诊断失败不影响插件
  }
}

/** 便于宿主/测试查看当前状态文件路径（also used by docs）。 */
export function describeStatusFile(): string {
  return statusFilePath()
}
