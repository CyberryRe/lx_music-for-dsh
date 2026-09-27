// 统计画像层（L1）：增量聚合 + 指数时间衰减 + 置信度门控（纯函数）。
//
// 关键设计（docs/design-taste-memory.md §5、§9）：
//   - **explicit 不衰减，implicit 衰减**。用户说"我喜欢金玟岐"，三个月没听也不该被抹掉；
//     "上周循环过"才该淡出。
//   - 衰减用**增量精确**方案：写入时先把累计值衰减到当前时刻再加上新信号，读取时再衰减到
//     `now`。对"多个指数衰减事件相加"是精确的，不需要定时任务、不需要重算。
//   - 权重只由本地确定性算法产出，LLM 只写注释（facets）——保证可解释、可重算。

import type { EntityDelta, TasteEntityKind } from './events'

/** 一条聚合实体（对应 taste_tracks / taste_artists / taste_tags 里的记录）。 */
export interface ProfileEntity {
  kind: TasteEntityKind
  /** 归一化 key。 */
  key: string
  /** 展示用原文（艺人名/曲名）。 */
  raw?: string
  /** 隐式分数（参与时间衰减）。 */
  implicit: number
  /** 显式分数（不衰减）。 */
  explicit: number
  plays: number
  skips: number
  /** implicit 分数对应的时刻（增量衰减的基准）。 */
  lastTs: number
  updatedAt: number
  /** 原始分数按半衰期衰减后的当前值（读侧计算，便于排序与展示）。 */
  score?: number
}

export type EntityTable = Record<string, ProfileEntity>

const DAY_MS = 86_400_000

/** 指数衰减系数：半衰期 halfLifeDays 天。 */
export function decayFactor(elapsedMs: number, halfLifeDays: number): number {
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 1
  const halfLife = halfLifeDays > 0 ? halfLifeDays : 1
  return Math.pow(0.5, elapsedMs / (halfLife * DAY_MS))
}

function round(value: number, digits = 4): number {
  const factor = Math.pow(10, digits)
  return Math.round(value * factor) / factor
}

/** 读侧分数：implicit 衰减到 now，explicit 原样相加。 */
export function readScore(entity: ProfileEntity, now: number, halfLifeDays: number): number {
  return round(entity.implicit * decayFactor(now - entity.lastTs, halfLifeDays) + entity.explicit)
}

/**
 * 把一组信号应用到实体表上（返回新表，不修改入参）。
 *
 * 计数规则：`plays` 只统计正向的"播放"信号（完整/部分/重播），`skips` 只统计负向切走信号——
 * 这是 UI 上"证据"的来源，也是置信度门控的样本量。
 */
export function applyDeltas(
  table: EntityTable,
  deltas: readonly EntityDelta[],
  options: { now: number; halfLifeDays: number; raw?: (delta: EntityDelta) => string | undefined },
): { table: EntityTable; changed: string[] } {
  const next: EntityTable = { ...table }
  const changed = new Set<string>()
  for (const delta of deltas) {
    if (!delta.key || delta.signal === 0) continue
    const existing = next[delta.key]
    const base: ProfileEntity =
      existing ?? { kind: delta.kind, key: delta.key, implicit: 0, explicit: 0, plays: 0, skips: 0, lastTs: options.now, updatedAt: options.now }
    const decayed = base.implicit * decayFactor(options.now - base.lastTs, options.halfLifeDays)
    const explicit = delta.provenance === 'implicit' ? base.explicit : base.explicit + delta.signal
    const implicit = delta.provenance === 'implicit' ? decayed + delta.signal : decayed
    const isNegative = delta.signal < 0
    next[delta.key] = {
      ...base,
      raw: base.raw ?? options.raw?.(delta),
      implicit: round(implicit),
      explicit: round(explicit),
      plays: base.plays + (isNegative ? 0 : 1),
      skips: base.skips + (isNegative ? 1 : 0),
      lastTs: options.now,
      updatedAt: options.now,
    }
    changed.add(delta.key)
  }
  return { table: next, changed: [...changed] }
}

/** 置信度档位：样本太少时不允许画像主导排序（§18.2 的探索护栏也用同一套档位）。 */
export type Confidence = 'none' | 'low' | 'medium' | 'high'

export function confidenceOf(entity: { plays: number; skips: number }): Confidence {
  const samples = entity.plays + entity.skips
  if (samples <= 0) return 'none'
  if (samples < 5) return 'low'
  if (samples <= 20) return 'medium'
  return 'high'
}

/** 画像用途：需要多高的置信度才允许。 */
export type ProfilePurpose = 'tiebreak' | 'rerank' | 'proactive'

/**
 * 门控：样本不足时降级使用。
 *   - `tiebreak`（同分打破）任何置信度都允许；
 *   - `rerank`（同 query 候选重排）需要 low 以上；
 *   - `proactive`（主动推荐 / 探索）需要 medium 以上。
 */
export function allowsPurpose(confidence: Confidence, purpose: ProfilePurpose): boolean {
  if (purpose === 'tiebreak') return true
  if (purpose === 'rerank') return confidence !== 'none'
  return confidence === 'medium' || confidence === 'high'
}

export interface RankedEntity extends ProfileEntity {
  score: number
  confidence: Confidence
  /** 显式分是否压过隐式分（用于 UI 上标注"你明确说过喜欢"）。 */
  explicitDominant: boolean
}

/**
 * 取分数最高的实体。
 *
 * `minPurpose` 会按置信度门控过滤：例如主动推荐只取 medium 以上的艺人，
 * 避免"点过两次就把用户锁死"。
 */
export function topEntities(
  table: EntityTable,
  options: { now: number; halfLifeDays: number; limit?: number; kind?: TasteEntityKind; minPurpose?: ProfilePurpose; includeNegative?: boolean },
): RankedEntity[] {
  const { now, halfLifeDays } = options
  const limit = options.limit ?? 10
  const ranked: RankedEntity[] = []
  for (const entity of Object.values(table)) {
    if (options.kind && entity.kind !== options.kind) continue
    const score = readScore(entity, now, halfLifeDays)
    const confidence = confidenceOf(entity)
    if (!options.includeNegative && score <= 0) continue
    if (options.minPurpose && !allowsPurpose(confidence, options.minPurpose)) continue
    ranked.push({
      ...entity,
      score,
      confidence,
      explicitDominant: Math.abs(entity.explicit) > Math.abs(score - entity.explicit),
    })
  }
  // 排序必须确定：分数降序 → 样本量降序 → key 升序（避免同分时顺序抖动，测试可复现）
  ranked.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    const sa = a.plays + a.skips
    const sb = b.plays + b.skips
    if (sb !== sa) return sb - sa
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0
  })
  return ranked.slice(0, limit)
}

/**
 * 增量事件裁剪：保留窗口之外的原始事件可以删除，但**聚合结果不受影响**
 * （衰减是显式的，聚合表里已经记录了 lastTs 与分数）。
 */
export function pruneEvents<T extends { ts: number }>(events: readonly T[], options: { now: number; retainDays: number; maxRecords?: number }): T[] {
  const cutoff = options.now - options.retainDays * DAY_MS
  const kept = events.filter((e) => e.ts >= cutoff)
  const max = options.maxRecords
  if (max !== undefined && kept.length > max) {
    return kept.slice(kept.length - max)
  }
  return kept
}
