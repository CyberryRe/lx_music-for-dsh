// 事件层（L0）测试：信号权重、归因三拆、探索折扣、标签 key 构造。
import { describe, expect, it } from './mini'
import {
  AI_ARTIST_DISCOUNT,
  COMPLETE_RATIO,
  EXPLORE_SKIP_DISCOUNT,
  SIGNAL,
  explicitDelta,
  hourTag,
  intentDeltas,
  moodArtistTag,
  moodTag,
  platformTag,
  qualityTag,
  searchMissDelta,
  settlePlaySession,
  type PlaySession,
} from '../src/taste/events'

const session = (over: Partial<PlaySession> = {}): PlaySession => ({
  title: '晴天',
  artist: '周杰伦',
  trackKey: '晴天|周杰伦',
  artistKey: '周杰伦',
  origin: 'user',
  mode: 'replay',
  playedRatio: 1,
  ts: Date.UTC(2026, 0, 1),
  ...over,
})

const find = (deltas: ReturnType<typeof settlePlaySession>, key: string) => deltas.find((d) => d.key === key)

describe('标签 key 构造', () => {
  it('平台/音质/情绪带命名空间前缀', () => {
    expect(platformTag('tx')).toBe('platform:tx')
    expect(qualityTag('flac')).toBe('quality:flac')
    expect(moodTag('frustrated')).toBe('mood:frustrated')
  })

  it('情绪×艺人组合标签（学"一烦就听谁"）', () => {
    expect(moodArtistTag('frustrated', '草东没有派对')).toBe('mood:frustrated@artist:草东没有派对')
  })

  it('时段按**本地**时间划分（23:00–05:00 为 night）', () => {
    const utc = (h: number): number => Date.UTC(2026, 0, 1, h)
    // 时区偏移 0（UTC）时，本地小时 = UTC 小时
    expect(hourTag(utc(2), 0)).toBe('hour:night')
    expect(hourTag(utc(7), 0)).toBe('hour:morning')
    expect(hourTag(utc(12), 0)).toBe('hour:day')
    expect(hourTag(utc(20), 0)).toBe('hour:evening')
    // 东八区（offset = -480 分钟）：UTC 20:00 是本地 04:00 → night
    expect(hourTag(utc(20), -480)).toBe('hour:night')
  })
})

describe('终态结算：完整播放', () => {
  it('比例 ≥0.8 → 曲目与艺人各 +2.0', () => {
    const deltas = settlePlaySession(session({ playedRatio: 0.95 }))
    expect(find(deltas, '晴天|周杰伦')?.signal).toBe(SIGNAL.complete)
    expect(find(deltas, '周杰伦')?.signal).toBe(SIGNAL.complete)
  })

  it('带情境时额外记录"情绪×艺人"关联', () => {
    const deltas = settlePlaySession(session({ playedRatio: 1, context: 'frustrated', artistKey: '草东没有派对' }))
    expect(find(deltas, 'mood:frustrated@artist:草东没有派对')?.signal).toBe(SIGNAL.complete)
  })

  it('部分播放（0.3~0.8）→ 各 +0.5', () => {
    const deltas = settlePlaySession(session({ playedRatio: 0.5 }))
    expect(find(deltas, '晴天|周杰伦')?.signal).toBe(SIGNAL.partial)
    expect(find(deltas, '周杰伦')?.signal).toBe(SIGNAL.partial)
  })
})

describe('终态结算：切走（归因三拆）', () => {
  it('用户点的歌被切走 → 曲目与艺人各 −1.5', () => {
    const deltas = settlePlaySession(session({ origin: 'user', playedRatio: 0.05 }))
    expect(find(deltas, '晴天|周杰伦')?.signal).toBe(SIGNAL.skipUser)
    expect(find(deltas, '周杰伦')?.signal).toBe(SIGNAL.skipUser)
  })

  it('AI 放的歌被切走 → 曲目 −1.0、艺人只 −0.3（不把 AI 的选择算成用户口味）', () => {
    const deltas = settlePlaySession(session({ origin: 'ai', playedRatio: 0.05, context: 'stuck' }))
    expect(find(deltas, '晴天|周杰伦')?.signal).toBe(SIGNAL.skipAiTrack)
    const artist = find(deltas, '周杰伦')
    expect(artist?.signal).toBe(SIGNAL.skipAiArtist)
    expect(artist?.signal).toBeGreaterThan(SIGNAL.skipAiTrack) // 打折：没有曲目那么重
    expect(AI_ARTIST_DISCOUNT).toBeLessThan(1)
  })

  it('AI 切走还会反馈到"策略"维度（该情境下选题不佳），而不是只怪艺人', () => {
    const deltas = settlePlaySession(session({ origin: 'ai', playedRatio: 0.02, context: 'frustrated' }))
    expect(find(deltas, 'strategy:frustrated')?.signal).toBe(SIGNAL.skipAiStrategy)
  })

  it('探索曲被切走：负反馈额外打折（防反向茧房）', () => {
    const normal = settlePlaySession(session({ origin: 'ai', mode: 'replay', playedRatio: 0.02 }))
    const explore = settlePlaySession(session({ origin: 'ai', mode: 'explore', playedRatio: 0.02 }))
    const normalArtist = find(normal, '周杰伦')?.signal ?? 0
    const exploreArtist = find(explore, '周杰伦')?.signal ?? 0
    expect(exploreArtist).toBeLessThan(0)
    // 探索的折扣是相对普通 AI 归因再乘 EXPLORE_SKIP_DISCOUNT
    expect(Math.abs(exploreArtist / normalArtist)).toBeCloseTo(EXPLORE_SKIP_DISCOUNT, 3)
  })

  it('探索曲完整播放仍然是正向证据（折扣只作用于负反馈）', () => {
    const deltas = settlePlaySession(session({ origin: 'ai', mode: 'explore', playedRatio: 1 }))
    expect(find(deltas, '周杰伦')?.signal).toBe(SIGNAL.complete)
  })
})

describe('终态结算：重播与阈值边界', () => {
  it('重播额外 +1.5（叠加在播放信号之上）', () => {
    const deltas = settlePlaySession(session({ playedRatio: 1, replayed: true }))
    const track = deltas.filter((d) => d.key === '晴天|周杰伦')
    expect(track).toHaveLength(2)
    expect(track[0]?.signal).toBe(SIGNAL.complete)
    expect(track[1]?.signal).toBe(SIGNAL.replay)
  })

  it('比例恰好等于阈值时按更高档处理（0.8 → 完整，0.3 → 部分）', () => {
    expect(find(settlePlaySession(session({ playedRatio: COMPLETE_RATIO })), '晴天|周杰伦')?.signal).toBe(SIGNAL.complete)
    expect(find(settlePlaySession(session({ playedRatio: 0.3 })), '晴天|周杰伦')?.signal).toBe(SIGNAL.partial)
  })

  it('比例越界/非数字时按 0 处理，不产生 NaN 信号', () => {
    for (const ratio of [Number.NaN, -1, 99]) {
      const deltas = settlePlaySession(session({ playedRatio: ratio }))
      expect(deltas.every((d) => Number.isFinite(d.signal))).toBe(true)
    }
  })
})

describe('意图 / 显式表态 / 搜索失败', () => {
  it('用户明确点歌：意图分只给用户侧；加入列表给所有人', () => {
    const user = intentDeltas({ trackKey: 'a|b', artistKey: 'b', origin: 'user', ts: 0 })
    expect(user.some((d) => d.reason === '用户明确点歌')).toBe(true)
    const ai = intentDeltas({ trackKey: 'a|b', artistKey: 'b', origin: 'ai', ts: 0 })
    expect(ai.some((d) => d.reason === '用户明确点歌')).toBe(false)
    expect(ai.every((d) => d.signal === SIGNAL.queued)).toBe(true)
  })

  it('显式表态走 explicit 通道，且幅度大于最强隐式信号', () => {
    const like = explicitDelta({ kind: 'artist', key: '金玟岐', liked: true, provenance: 'explicit-chat' })
    expect(like.provenance).toBe('explicit-chat')
    expect(like.signal).toBe(SIGNAL.explicitLike)
    expect(Math.abs(like.signal)).toBeGreaterThan(SIGNAL.complete)
    const dislike = explicitDelta({ kind: 'artist', key: 'x', liked: false, provenance: 'explicit-ui', note: '太吵' })
    expect(dislike.signal).toBe(SIGNAL.explicitDislike)
    expect(dislike.reason).toContain('太吵')
  })

  it('搜索后未选就改 query → 对平台维度的负反馈', () => {
    expect(searchMissDelta('wy').key).toBe('platform:wy')
    expect(searchMissDelta('wy').signal).toBe(SIGNAL.searchMiss)
  })
})
