// 画像配置（持久化在 `global.memory`）。
//
// 两个职责，别混：
//   1. `memoryConfigSchema` —— **持久层读边界**的松散 schema（字段全可选）；
//   2. `normalizeMemoryConfig()` —— 读侧归一化，把缺字段/越界的旧数据合并成确定值。
//
// ⚠️ 音乐画像是实验性功能，默认关闭；开启必须有用户显式确认（见 experimentalOptInAt）。

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
  /**
   * **显式开启凭证**（ISO 时间）：用户在设置里看到红色警示、点过确认按钮才会写入。
   *
   * 没有它时 `enabled` 一律按 false 处理 —— 这样老版本（1.2.0/1.2.1 默认开启时代）写下的
   * `enabled: true` 不会在升级后继续偷偷采集。实测问题：用户升级到 1.2.2 后仍在记录切歌，
   * 就是因为持久层里存着旧的 `enabled: true`。
   */
  experimentalOptInAt: z.string().optional(),
})

/** 读侧归一化后的画像配置（所有字段都有确定值）。 */
export interface MemoryConfig {
  enabled: boolean
  /** 显式开启凭证；缺失时 enabled 恒为 false（见 memoryConfigSchema.experimentalOptInAt）。 */
  experimentalOptInAt?: string
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

/**
 * 默认配置。
 *
 * ⚠️ `enabled` 默认 **false**：音乐画像是**实验性功能**，默认完全不采集、不参与点歌。
 * 用户必须在**设置窗口的「实验性」页**看到红色警示并显式确认后才会开启
 * （见 SettingsWindow.tsx 的双重确认与 docs/development.md §9.2）。
 * 理由：它记录收听行为并影响 AI 的选歌决策，在打磨完成前不应该悄悄生效。
 */
export const DEFAULT_MEMORY_CONFIG: MemoryConfig = {
  enabled: false,
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
  const optIn = typeof value.experimentalOptInAt === 'string' && value.experimentalOptInAt.length > 0 ? value.experimentalOptInAt : undefined
  return {
    // ⚠️ 只有**显式确认过**才可能开启：老的 `enabled: true`（1.2.0/1.2.1 默认开启时代写下的）
    // 不算凭证，升级后自动按关闭处理；用户重新确认才会真正采集。
    enabled: optIn !== undefined && value.enabled === true,
    ...(optIn !== undefined ? { experimentalOptInAt: optIn } : {}),
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
