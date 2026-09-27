// 播放来源的**环境传递**（ambient），不进 Typert wire 契约。
//
// 为什么需要：同一个 `PlaybackService` 既被 client（用户点按 → 用户意图）调用，也被 LLM 工具
// （AI 主动点歌 → AI 意图）调用。归因三拆要求区分这两者——AI 放了一首被切走 ≠ 用户讨厌这个艺人
// （设计文档 §3）。
//
// 为什么不用 ALS 之外的办法：
//   - 给 @Remote 方法加参数会改变 wire 契约的形参个数（remote-contribution 测试与两代 DSH 的
//     strict codec 都依赖它），代价过大；
//   - 用一个"待消费字段"在并发工具调用下会被互相覆盖。
// AsyncLocalStorage 天然按异步作用域隔离，且服务端在方法入口**同步读取**，没有交错风险。

import { AsyncLocalStorage } from 'node:async_hooks'
import type { TasteEventMode, TasteEventOrigin } from './events'

export interface PlayContext {
  origin: TasteEventOrigin
  mode?: TasteEventMode
  /** 情境（来自 skill 的情绪语义，如 frustrated/stuck/happy/focused）。 */
  context?: string
}

const storage = new AsyncLocalStorage<PlayContext>()

/** 在给定来源下执行（工具层用它包住对 service 的调用）。 */
export function runWithPlayContext<T>(context: PlayContext, fn: () => T): T {
  return storage.run(context, fn)
}

/** 读取当前来源；没有显式包裹时视为用户操作（client 路径）。 */
export function currentPlayContext(): PlayContext {
  return storage.getStore() ?? { origin: 'user' }
}
