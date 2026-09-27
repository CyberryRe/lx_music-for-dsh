// 画像表的持久层 schema 测试。
//
// 这是 1.0.1 事故的正面锁：schema 是持久层**读边界校验**，只要它比实际写入更严格，
// 整条记录就不可读（轻则 backup-and-skip 丢数据，重则整个 domain 打不开）。
// 所以这里用"代码真的会写出的形状"去撞 schema，而不是用想象的形状。

import { describe, expect, it } from './mini'
import { domainSpec } from '../src/index'
import {
  musicInfoSchema,
  storedArtistSchema,
  storedTagSchema,
  storedTrackSchema,
  tasteEventDaySchema,
  tasteStateSchema,
} from '../src/taste/schema'
import { TASTE_TABLES } from '../src/taste/store'

/** 真实的 MusicInfo（含 tx 平台私有字段——spike #5 抓到的形状）。 */
const REAL_TX_MUSIC = {
  id: 'tx_0039MnYb0qxYhV',
  name: '晴天',
  singer: '周杰伦',
  source: 'tx' as const,
  interval: '04:29',
  meta: {
    songId: '0039MnYb0qxYhV',
    albumName: '叶惠美',
    albumId: 12345,
    picUrl: 'https://example.com/p.jpg',
    qualitys: [{ type: 'flac' as const, size: '28.1M' }, { type: '320k' as const, size: null }],
    strMediaMid: '0020wJDo3cx0j3',
    albumMid: '002Neh8l0uciQZ',
    id: 998877,
  },
}

describe('MusicInfo schema（Tier-1 直取的可播放载荷）', () => {
  it('接受真实 MusicInfo，并**保留平台私有字段**（catchall，直取解析要用）', () => {
    const parsed = musicInfoSchema.safeParse(REAL_TX_MUSIC)
    expect(parsed.success).toBe(true)
    const meta = (parsed as { data: { meta: Record<string, unknown> } }).data.meta
    expect(meta.strMediaMid).toBe('0020wJDo3cx0j3')
    expect(meta.albumMid).toBe('002Neh8l0uciQZ')
    expect(meta.albumName).toBe('叶惠美')
  })

  it('interval 允许 null（SDK 在未知时长时给 null）', () => {
    expect(musicInfoSchema.safeParse({ ...REAL_TX_MUSIC, interval: null }).success).toBe(true)
  })

  it('拒绝未知音质类型（避免把脏数据写进画像）', () => {
    const bad = { ...REAL_TX_MUSIC, meta: { ...REAL_TX_MUSIC.meta, qualitys: [{ type: 'hires' }] } }
    expect(musicInfoSchema.safeParse(bad).success).toBe(false)
  })

  it('拒绝缺关键字段的形状', () => {
    expect(musicInfoSchema.safeParse({ id: 'x', name: 'y' }).success).toBe(false)
  })
})

describe('domainSpec 已接上画像表', () => {
  it('五张画像表都在 spec 里（与 TASTE_TABLES 清单一致，防止只改一边）', () => {
    const names = Object.keys(domainSpec.tables)
    for (const table of TASTE_TABLES) {
      expect(names).toContain(table)
    }
  })
})

describe('聚合记录 schema', () => {
  const score = { implicit: 2, explicit: 0, plays: 3, skips: 1, lastTs: 1_700_000_000_000, updatedAt: 1_700_000_000_000 }

  it('曲目记录：最小形状（只确认过身份）合法', () => {
    const record = { kind: 'track', key: '晴天|周杰伦', title: '晴天', artist: '周杰伦', status: 'seen', ...score }
    expect(storedTrackSchema.safeParse(record).success).toBe(true)
  })

  it('曲目记录：带多平台引用与探索标记的完整形状合法', () => {
    const record = {
      kind: 'track',
      key: '晴天|周杰伦',
      title: '晴天',
      artist: '周杰伦',
      status: 'played',
      variant: 'original',
      album: '叶惠美',
      durationSec: 269,
      lastSource: 'tx',
      refs: { tx: { music: REAL_TX_MUSIC, lastOkAt: 1, lastResolvedAt: 1, lastScript: 'HYWmusic' } },
      lastPlayedAt: 1,
      lastExploredAt: 2,
      ...score,
    }
    expect(storedTrackSchema.safeParse(record).success).toBe(true)
  })

  it('曲目记录：status 只能是 seen/played（探索池依赖这个区分）', () => {
    const bad = { kind: 'track', key: 'k', title: 't', artist: 'a', status: 'maybe', ...score }
    expect(storedTrackSchema.safeParse(bad).success).toBe(false)
  })

  it('艺人记录：raw 必填（UI 要显示原文）', () => {
    expect(storedArtistSchema.safeParse({ kind: 'artist', key: 'zhoujielun', raw: '周杰伦', ...score }).success).toBe(true)
    expect(storedArtistSchema.safeParse({ kind: 'artist', key: 'zhoujielun', ...score }).success).toBe(false)
  })

  it('标签记录：tag 与 strategy 共用一张表', () => {
    expect(storedTagSchema.safeParse({ kind: 'tag', key: 'platform:tx', ...score }).success).toBe(true)
    expect(storedTagSchema.safeParse({ kind: 'strategy', key: 'strategy:frustrated', label: '烦躁时选题', ...score }).success).toBe(true)
    expect(storedTagSchema.safeParse({ kind: 'genre', key: 'x', ...score }).success).toBe(false)
  })
})

describe('事件与状态 schema', () => {
  it('事件按天分桶：一天一个数组', () => {
    const day = {
      date: '2026-01-01',
      events: [
        {
          ts: 1,
          kind: 'settle',
          origin: 'ai',
          mode: 'explore',
          trackKey: '晴天|周杰伦',
          artistKey: '周杰伦',
          title: '晴天',
          artist: '周杰伦',
          source: 'tx',
          playedRatio: 0.02,
          replayed: false,
          context: 'frustrated',
          deltas: [{ kind: 'artist', key: '周杰伦', signal: -0.3, reason: '2% 切走（AI 放的，艺人维度打折）', provenance: 'implicit' }],
        },
      ],
    }
    expect(tasteEventDaySchema.safeParse(day).success).toBe(true)
  })

  it('事件：origin/mode/provenance 取值受限（写错枚举会被拦下）', () => {
    const base = { date: '2026-01-01', events: [{ ts: 1, kind: 'settle', origin: 'robot', mode: 'replay' }] }
    expect(tasteEventDaySchema.safeParse(base).success).toBe(false)
    const badMode = { date: '2026-01-01', events: [{ ts: 1, kind: 'settle', origin: 'ai', mode: 'random' }] }
    expect(tasteEventDaySchema.safeParse(badMode).success).toBe(false)
  })

  it('状态记录：摘要与探索统计', () => {
    const state = {
      summary: '近 90 天常听：周杰伦',
      topArtists: ['周杰伦'],
      sampleSize: 12,
      generatedAt: 1,
      exploreStats: { replayPlays: 5, replaySkips: 1, explorePlays: 3, exploreSkips: 2, exploreRatio: 0.2 },
    }
    expect(tasteStateSchema.safeParse(state).success).toBe(true)
  })

  it('状态记录：探索统计缺字段会被拦下（自适应探索率依赖它完整）', () => {
    expect(tasteStateSchema.safeParse({ exploreStats: { replayPlays: 1 } }).success).toBe(false)
  })
})
