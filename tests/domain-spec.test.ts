// domain spec 契约测试：锁住 1.2.0 的两个存储决策 + global 的向后兼容形状。
//
// 为什么值得单独锁：
//   - `layout` 决定写放大（events/画像写入频繁，single 要整份重写）；
//   - `invalidRecords` **只在 per-record 下生效**（single 下坏记录仍会殉爆整个 open =
//     1.0.1 的事故机制）。两者必须成对存在，任何一方被误删都要立刻失败。
//   - global schema 是持久层**读边界校验**：老数据缺 `memory` 字段必须仍能通过（否则
//     升级后第一次打开就会 invalid-record）。

import { describe, expect, it } from './mini'
import { domainSpec } from '../src/index'
import { memoryConfigSchema, DEFAULT_MEMORY_CONFIG, normalizeMemoryConfig } from '../src/taste/config'

describe('domainSpec（1.2.0 存储决策）', () => {
  it('声明 per-record 布局与 backup-and-skip（两者必须成对）', () => {
    expect(domainSpec.layout).toBe('per-record')
    expect(domainSpec.invalidRecords).toBe('backup-and-skip')
  })

  it('version 保持 1（per-record 下不接受的版本戳会丢弃记录，升版无收益）', () => {
    expect(domainSpec.version).toBe(1)
  })

  it('tables 至少包含既有三张表（1.0.x 数据必须继续可读）', () => {
    const names = Object.keys(domainSpec.tables)
    for (const required of ['logs', 'sources', 'source_order']) {
      expect(names).toContain(required)
    }
  })

  it('global schema 接受"没有 memory 字段"的老数据（升级兼容）', () => {
    const legacyGlobal = { playlist: [], currentIndex: -1, quality: '320k', volume: 1, mute: false, playMode: 'list' }
    const parsed = domainSpec.global.schema.safeParse(legacyGlobal)
    expect(parsed.success).toBe(true)
  })

  it('global schema 保留 playMode / settings（历史回归：漏声明会被 zod 丢弃）', () => {
    const parsed = domainSpec.global.schema.safeParse({
      playlist: [{ id: 'wy_1' }],
      currentIndex: 0,
      quality: 'flac',
      volume: 0.5,
      mute: true,
      playMode: 'shuffle',
      settings: { platformPriority: ['tx'] },
      memory: { enabled: false, halfLifeDays: 30 },
    })
    expect(parsed.success).toBe(true)
  })

  it('global schema 拒绝损坏的形状（不能放行坏记录）', () => {
    expect(domainSpec.global.schema.safeParse({ playlist: [], currentIndex: -1, quality: 'nope', volume: 1, mute: false }).success).toBe(false)
  })

  it('domain 名与新版一致（迁移/旧文件按此定位）', () => {
    expect(domainSpec.name).toBe('lx_music')
  })
})

describe('画像配置（global.memory）', () => {
  it('memoryConfigSchema 全部字段可选，空对象也合法', () => {
    expect(memoryConfigSchema.safeParse({}).success).toBe(true)
  })

  it('normalizeMemoryConfig 为空值提供默认：**默认关闭**（实验性）、纯本地语义层、90 天半衰期', () => {
    const cfg = normalizeMemoryConfig(undefined)
    // 实验性功能：默认必须是关闭的（开启需要 UI 里的红色警示 + 二次确认）
    expect(cfg.enabled).toBe(false)

    // ⚠️ 升级兼容：老版本（默认开启时代）写下的 `enabled: true` 没有凭证 → 必须按关闭处理，
    // 否则用户升级后仍在被记录（1.2.2 实测问题："我看现在仍然会有切歌之类的记录"）。
    expect(normalizeMemoryConfig({ enabled: true, halfLifeDays: 30 }).enabled).toBe(false)
    // 有凭证（用户在红色警示后确认过）才真正开启，并保留凭证供 UI 判断
    const opted = normalizeMemoryConfig({ enabled: true, experimentalOptInAt: '2026-09-29T00:00:00.000Z' })
    expect(opted.enabled).toBe(true)
    expect(opted.experimentalOptInAt).toBe('2026-09-29T00:00:00.000Z')
    // 凭证在但开关关着 → 关闭（用户后来关掉了）
    expect(normalizeMemoryConfig({ enabled: false, experimentalOptInAt: '2026-09-29T00:00:00.000Z' }).enabled).toBe(false)
    expect(cfg.halfLifeDays).toBe(90)
    expect(cfg.retainDays).toBe(90)
    expect(cfg.budget).toBe('balanced')
    expect(cfg.semanticProfile).toBe('local-only')
    expect(cfg.profileCallsPerHour).toBe(20)
    expect(cfg.exploreRatio).toBe(DEFAULT_MEMORY_CONFIG.exploreRatio)
  })

  it('normalizeMemoryConfig 夹紧越界值（预算/半衰期/探索率）', () => {
    const cfg = normalizeMemoryConfig({ halfLifeDays: -5, retainDays: 99999, exploreRatio: 3, profileCallsPerHour: -1, budget: 'nope', semanticProfile: 'x' })
    expect(cfg.halfLifeDays).toBe(1)
    expect(cfg.retainDays).toBe(3650)
    expect(cfg.exploreRatio).toBe(1)
    expect(cfg.profileCallsPerHour).toBe(0)
    expect(cfg.budget).toBe(DEFAULT_MEMORY_CONFIG.budget)
    expect(cfg.semanticProfile).toBe(DEFAULT_MEMORY_CONFIG.semanticProfile)
  })

  it('normalizeMemoryConfig 保留合法自定义值与迁移标记', () => {
    const cfg = normalizeMemoryConfig({ enabled: false, budget: 'rich', semanticProfile: 'llm-assisted', migratedFrom: 'single@2026-01-01T00:00:00.000Z', onboardedAt: '2026-01-01T00:00:00.000Z' })
    expect(cfg.enabled).toBe(false)
    expect(cfg.budget).toBe('rich')
    expect(cfg.semanticProfile).toBe('llm-assisted')
    expect(cfg.migratedFrom).toBe('single@2026-01-01T00:00:00.000Z')
    expect(cfg.onboardedAt).toBe('2026-01-01T00:00:00.000Z')
  })
})
