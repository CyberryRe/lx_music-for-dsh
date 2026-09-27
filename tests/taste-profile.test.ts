// 统计画像（L1）测试：增量精确衰减、explicit 不衰减、置信度门控、排序确定性、事件裁剪。
import { describe, expect, it } from './mini'
import { explicitDelta, settlePlaySession, type EntityDelta } from '../src/taste/events'
import {
  allowsPurpose,
  applyDeltas,
  confidenceOf,
  decayFactor,
  pruneEvents,
  readScore,
  topEntities,
  type EntityTable,
} from '../src/taste/profile'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)
const HALF = 90

const implicit = (key: string, signal: number, reason = '完整播放'): EntityDelta => ({ kind: 'artist', key, signal, reason, provenance: 'implicit' })

/** 依次在给定时刻应用信号，返回最终表。 */
function applySeries(deltas: ReadonlyArray<{ ts: number; delta: EntityDelta }>): EntityTable {
  let table: EntityTable = {}
  for (const { ts, delta } of deltas) {
    table = applyDeltas(table, [delta], { now: ts, halfLifeDays: HALF }).table
  }
  return table
}

describe('指数衰减', () => {
  it('半衰期就是 90 天：过一个半衰期剩一半', () => {
    expect(decayFactor(HALF * DAY, HALF)).toBeCloseTo(0.5, 10)
    expect(decayFactor(2 * HALF * DAY, HALF)).toBeCloseTo(0.25, 10)
    expect(decayFactor(0, HALF)).toBe(1)
  })

  it('时间倒流/零间隔不放大分数（系数上限 1）', () => {
    expect(decayFactor(-DAY, HALF)).toBe(1)
    expect(decayFactor(0, HALF)).toBe(1)
  })

  it('implicit 分数随时间衰减', () => {
    const table = applySeries([{ ts: T0, delta: implicit('周杰伦', 2) }])
    expect(readScore(table['周杰伦']!, T0, HALF)).toBeCloseTo(2, 4)
    expect(readScore(table['周杰伦']!, T0 + HALF * DAY, HALF)).toBeCloseTo(1, 4)
    expect(readScore(table['周杰伦']!, T0 + 2 * HALF * DAY, HALF)).toBeCloseTo(0.5, 4)
  })

  it('增量衰减与"一次性重算"数学等价（多个不同时刻的信号相加）', () => {
    const table = applySeries([
      { ts: T0, delta: implicit('周杰伦', 2) },
      { ts: T0 + HALF * DAY * 0.5, delta: implicit('周杰伦', 3) },
      { ts: T0 + HALF * DAY * 0.8, delta: implicit('周杰伦', -1) },
    ])
    const now = T0 + HALF * DAY
    const manual =
      2 * Math.pow(0.5, 1) + 3 * Math.pow(0.5, (HALF * DAY - HALF * DAY * 0.5) / (HALF * DAY)) + -1 * Math.pow(0.5, (HALF * DAY - HALF * DAY * 0.8) / (HALF * DAY))
    expect(readScore(table['周杰伦']!, now, HALF)).toBeCloseTo(manual, 2)
  })
})

describe('explicit 不衰减（"我喜欢金玟岐"三个月没听也不该被抹掉）', () => {
  it('显式分数不随时间变化，隐式分数照常衰减', () => {
    let table = applyDeltas({}, [implicit('金玟岐', 2)], { now: T0, halfLifeDays: HALF }).table
    table = applyDeltas(table, [explicitDelta({ kind: 'artist', key: '金玟岐', liked: true, provenance: 'explicit-ui' })], { now: T0, halfLifeDays: HALF }).table

    const entity = table['金玟岐']!
    expect(entity.explicit).toBe(3)

    // 时间旅行：20 个半衰期后
    const far = T0 + 20 * HALF * DAY
    const score = readScore(entity, far, HALF)
    expect(score).toBeCloseTo(3, 3) // 隐式早已归零，只剩显式
    expect(entity.explicit).toBe(3) // 存储值本身也不变
  })

  it('显式不喜欢记负分，且与喜欢叠加（先喜欢后不喜欢 → 净 0）', () => {
    let table = applyDeltas({}, [explicitDelta({ kind: 'artist', key: 'x', liked: true, provenance: 'explicit-chat' })], { now: T0, halfLifeDays: HALF }).table
    table = applyDeltas(table, [explicitDelta({ kind: 'artist', key: 'x', liked: false, provenance: 'explicit-chat' })], { now: T0, halfLifeDays: HALF }).table
    expect(table['x']!.explicit).toBe(0)
  })
})

describe('计数与可解释性', () => {
  it('plays 只统计正向、skips 只统计负向（UI 的"证据"来源）', () => {
    const deltas = [
      ...settlePlaySession({ title: '晴天', artist: '周杰伦', trackKey: '晴天|周杰伦', artistKey: '周杰伦', origin: 'user', mode: 'replay', playedRatio: 1, ts: T0 }),
      ...settlePlaySession({ title: '晴天', artist: '周杰伦', trackKey: '晴天|周杰伦', artistKey: '周杰伦', origin: 'user', mode: 'replay', playedRatio: 0.02, ts: T0 }),
    ]
    const table = applyDeltas({}, deltas, { now: T0, halfLifeDays: HALF, raw: () => '周杰伦' }).table
    const artist = table['周杰伦']!
    expect(artist.plays).toBe(1)
    expect(artist.skips).toBe(1)
    expect(artist.raw).toBe('周杰伦')
    // 一次完整(+2) 一次切走(-1.5) → 净 +0.5
    expect(readScore(artist, T0, HALF)).toBeCloseTo(0.5, 3)
  })

  it('信号为 0 或 key 为空时被忽略', () => {
    const table = applyDeltas({}, [implicit('', 5), implicit('x', 0)], { now: T0, halfLifeDays: HALF }).table
    expect(Object.keys(table)).toEqual([])
  })

  it('不修改入参（纯函数）', () => {
    const original: EntityTable = {}
    const { table } = applyDeltas(original, [implicit('a', 1)], { now: T0, halfLifeDays: HALF })
    expect(Object.keys(original)).toEqual([])
    expect(Object.keys(table)).toEqual(['a'])
  })
})

describe('置信度门控（样本太少不许画像主导）', () => {
  it('档位按样本量划分', () => {
    expect(confidenceOf({ plays: 0, skips: 0 })).toBe('none')
    expect(confidenceOf({ plays: 2, skips: 0 })).toBe('low')
    expect(confidenceOf({ plays: 5, skips: 0 })).toBe('medium')
    expect(confidenceOf({ plays: 21, skips: 0 })).toBe('high')
  })

  it('只点过 2 次（low）不允许主动推荐/探索，但允许同分打破与重排', () => {
    expect(allowsPurpose('low', 'tiebreak')).toBe(true)
    expect(allowsPurpose('low', 'rerank')).toBe(true)
    expect(allowsPurpose('low', 'proactive')).toBe(false)
  })

  it('毫无样本（none）连重排都不允许', () => {
    expect(allowsPurpose('none', 'tiebreak')).toBe(true)
    expect(allowsPurpose('none', 'rerank')).toBe(false)
    expect(allowsPurpose('none', 'proactive')).toBe(false)
  })

  it('medium/high 允许主动推荐', () => {
    expect(allowsPurpose('medium', 'proactive')).toBe(true)
    expect(allowsPurpose('high', 'proactive')).toBe(true)
  })
})

describe('排序（topEntities）', () => {
  it('按分数降序；分相同按样本量；再相同按 key（结果确定、可复现）', () => {
    let table: EntityTable = {}
    const add = (key: string, times: number): void => {
      for (let i = 0; i < times; i++) {
        table = applyDeltas(table, [implicit(key, 1)], { now: T0, halfLifeDays: HALF }).table
      }
    }
    add('b', 3)
    add('a', 3)
    add('c', 1)
    const ranked = topEntities(table, { now: T0, halfLifeDays: HALF, limit: 5 })
    expect(ranked.map((r) => r.key)).toEqual(['a', 'b', 'c'])
  })

  it('默认过滤非正分实体；includeNegative 可保留（用于"我不喜欢"的黑名单）', () => {
    let table = applyDeltas({}, [implicit('好', 2), implicit('坏', -2)], { now: T0, halfLifeDays: HALF }).table
    expect(topEntities(table, { now: T0, halfLifeDays: HALF }).map((r) => r.key)).toEqual(['好'])
    expect(topEntities(table, { now: T0, halfLifeDays: HALF, includeNegative: true }).map((r) => r.key)).toEqual(['好', '坏'])
  })

  it('minPurpose=proactive 会滤掉低置信度实体（避免两次点歌就锁死用户）', () => {
    let table = applyDeltas({}, [implicit('只点过两次', 4)], { now: T0, halfLifeDays: HALF }).table
    table = applyDeltas(table, [implicit('只点过两次', 4)], { now: T0, halfLifeDays: HALF }).table
    let solid: EntityTable = {}
    for (let i = 0; i < 6; i++) solid = applyDeltas(solid, [implicit('老听众', 1)], { now: T0, halfLifeDays: HALF }).table
    for (const [key, value] of Object.entries(solid)) table[key] = value

    const all = topEntities(table, { now: T0, halfLifeDays: HALF })
    const gated = topEntities(table, { now: T0, halfLifeDays: HALF, minPurpose: 'proactive' })
    expect(all).toHaveLength(2)
    expect(gated.map((r) => r.key)).toEqual(['老听众'])
  })

  it('kind 过滤与 limit 生效；并标出显式分是否占主导', () => {
    let table = applyDeltas({}, [implicit('艺人A', 1)], { now: T0, halfLifeDays: HALF }).table
    table = applyDeltas(table, [
      { kind: 'tag', key: 'platform:tx', signal: 5, reason: '平台', provenance: 'implicit' },
      explicitDelta({ kind: 'artist', key: '艺人B', liked: true, provenance: 'explicit-ui' }),
    ], { now: T0, halfLifeDays: HALF }).table

    expect(topEntities(table, { now: T0, halfLifeDays: HALF, kind: 'artist' }).map((r) => r.key)).toEqual(['艺人B', '艺人A'])
    expect(topEntities(table, { now: T0, halfLifeDays: HALF, kind: 'tag' }).map((r) => r.key)).toEqual(['platform:tx'])
    expect(topEntities(table, { now: T0, halfLifeDays: HALF, limit: 1 })).toHaveLength(1)
    const b = topEntities(table, { now: T0, halfLifeDays: HALF, kind: 'artist' })[0]!
    expect(b.explicitDominant).toBe(true)
  })
})

describe('事件裁剪（保留窗口与条数上限）', () => {
  const events = [
    { ts: T0, id: 'old' },
    { ts: T0 + 89 * DAY, id: 'recent' },
    { ts: T0 + 91 * DAY, id: 'newest' },
  ]

  it('窗口外的旧事件被裁掉（聚合结果不受影响，因为聚合已显式记分）', () => {
    const kept = pruneEvents(events, { now: T0 + 91 * DAY, retainDays: 90 })
    expect(kept.map((e) => e.id)).toEqual(['recent', 'newest'])
  })

  it('条数上限保留最新的', () => {
    const kept = pruneEvents(events, { now: T0 + 91 * DAY, retainDays: 90, maxRecords: 1 })
    expect(kept.map((e) => e.id)).toEqual(['newest'])
  })

  it('未超限时原样返回', () => {
    expect(pruneEvents(events, { now: T0 + 1 * DAY, retainDays: 3650 }).length).toBe(3)
  })
})
