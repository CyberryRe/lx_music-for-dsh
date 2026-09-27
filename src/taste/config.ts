import { z } from 'zod'

/** 画像预算档位：控制 music_profile 返回的候选数与理由详细度（见设计文档 §10）。 */
export type MemoryBudget = 'off' | 'minimal' | 'balanced' | 'rich'

/** 语义标注层模式：off / 纯本地（共现簇 + 显式种子）/ 允许 LLM 标注（设计文档 §9）。 */
export type SemanticProfileMode = 'off' | 'local-only' | 'llm-assisted'

/**
 * 持久化在 `global.memory` 里的画像配置。
 *
 * **所有字段可选**是刻意的：global 是持久层读边界校验对象，任何一条记录不匹配都会
 * 触发 invalid-record（1.2.0 起会 backup-and-skip，但仍是噪音）。字段可选 + 读侧
 * `normalizeMemoryConfig()` 合并默认值，能让后续版本新增字段时老数据继续可读。
 */
export const memoryConfigSchema = z.object({
  enabled: z.boolean().optional(),
  /** 首启引导完成时间（ISO）；为空表示"该弹引导页"。 */
  onboardedAt: z.string().optional(),
  /** 用户点了"稍后"，在此之前不再自动弹引导页（ISO）。 */
  snoozedUntil: z.string().optional(),
  /** implicit 权重的指数衰减半衰期（天）。 */
  halfLifeDays: z.number().optional(),
  /** 原始事件保留窗口（天）；聚合结果长期保留。 */
  retainDays: z.number().optional(),
  budget: z.enum(['off', 'minimal', 'balanced', 'rich']).optional(),
  semanticProfile: z.enum(['off', 'local-only', 'llm-assisted']).optional(),
  /** music_profile 每滑动窗口（1 小时）的调用上限，防刷/防成本失控。 */
  profileCallsPerHour: z.number().optional(),
  /** 探索比例（0~1）：AI 主动点歌时走"没听过的歌"的概率。 */
  exploreRatio: z.number().optional(),
  /** 一次性迁移标记（如 `single@2026-01-01T00:00:00.000Z`）；存在即表示已迁移。 */
  migratedFrom: z.string().optional(),
})

/** 读侧归一化后的画像配置（所有字段都有确定值）。 */
export interface MemoryConfig {
  enabled: boolean
  onboardedAt?: string
  snoozedUntil?: string
  halfLifeDays: number
  retainDays: number
  budget: MemoryBudget
  semanticProfile: SemanticProfileMode
  profileCallsPerHour: number
  exploreRatio: number
  migratedFrom?: string
}

/** 默认值：默认开启画像（用户可在首启引导里关闭），纯本地语义层。 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: true,
  halfLifeDays: 90,
  retainDays: 90,
  budget: 'balanced',
  semanticProfile: 'local-only',
  profileCallsPerHour: 20,
  exploreRatio: 0.2,
}

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/** 把持久层里可能缺字段/越界的画像配置合并成确定值。 */
export function normalizeMemoryConfig(raw: unknown): MemoryConfig {
  const value = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const budget = value.budget
  const semantic = value.semanticProfile
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_MEMORY_CONFIG.enabled,
    ...(typeof value.onboardedAt === 'string' ? { onboardedAt: value.onboardedAt } : {}),
    ...(typeof value.snoozedUntil === 'string' ? { snoozedUntil: value.snoozedUntil } : {}),
    halfLifeDays: num(value.halfLifeDays, DEFAULT_MEMORY_CONFIG.halfLifeDays, 1, 3650),
    retainDays: num(value.retainDays, DEFAULT_MEMORY_CONFIG.retainDays, 1, 3650),
    budget: budget === 'off' || budget === 'minimal' || budget === 'balanced' || budget === 'rich' ? budget : DEFAULT_MEMORY_CONFIG.budget,
    semanticProfile:
      semantic === 'off' || semantic === 'local-only' || semantic === 'llm-assisted' ? semantic : DEFAULT_MEMORY_CONFIG.semanticProfile,
    profileCallsPerHour: num(value.profileCallsPerHour, DEFAULT_MEMORY_CONFIG.profileCallsPerHour, 0, 1000),
    exploreRatio: num(value.exploreRatio, DEFAULT_MEMORY_CONFIG.exploreRatio, 0, 1),
    ...(typeof value.migratedFrom === 'string' ? { migratedFrom: value.migratedFrom } : {}),
  }
}
