// TasteStore 测试：聚合落盘、可播放引用（Tier-1）、seen/played 分离、事件分桶与裁剪、清空。
//
// 关键的一条：**store 真实写出的每一条记录都要能被 domain schema 接受**。
// 这里把 fake storage 里所有写入抓出来逐条 safeParse —— 任何形状漂移都会立刻失败，
// 而不是等用户升级后整个 domain 打不开（1.0.1 的教训）。

import { describe, expect, it } from './mini'
import { domainSpec } from '../src/index'
import type { StorageFace } from '../src/playback'
import { MAX_EVENTS_PER_DAY, TasteStore, dayKey } from '../src/taste/store'
import { explicitDelta, settlePlaySession, type EntityDelta } from '../src/taste/events'
import type { MusicInfo } from '../src/shared/types'

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)

function fakeStorage(): StorageFace & { raw: Map<string, Map<string, unknown>> } {
  const raw = new Map<string, Map<string, unknown>>()
  return {
    raw,
    global: { get: () => undefined, set: async () => {} },
    table: (name: string) => {
      if (!raw.has(name)) raw.set(name, new Map())
      const t = raw.get(name)!
      return {
        get: (k: string) => t.get(k),
        put: async (k: string, v: unknown) => {
          t.set(k, v)
        },
        entries: () => t.entries(),
        delete: async (k: string) => t.delete(k),
      }
    },
  }
}

const MUSIC_TX: MusicInfo = {
  id: 'tx_0039MnYb0qxYhV',
  name: '晴天',
  singer: '周杰伦',
  source: 'tx',
  interval: '04:29',
  meta: { songId: '0039MnYb0qxYhV', albumName: '叶惠美', strMediaMid: 'x' },
}

const MUSIC_WY: MusicInfo = { ...MUSIC_TX, id: 'wy_186016', source: 'wy' }

const track = (trackKey: string, trackKeyArtist: string): EntityDelta[] =>
  settlePlaySession({
    title: '晴天',
    artist: '周杰伦',
    trackKey,
    artistKey: trackKeyArtist,
    origin: 'user',
    mode: 'replay',
    playedRatio: 1,
    ts: T0,
  })

describe('TasteStore：聚合与落盘', () => {
  it('信号写入对应表并按 key 落盘', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    const result = await store.applyDeltas(track('晴天|周杰伦', '周杰伦'), { now: T0, halfLifeDays: 90 })

    expect(result.changed.sort()).toEqual(['周杰伦', '晴天|周杰伦'])
    expect(storage.raw.get('taste_tracks')?.has('晴天|周杰伦')).toBe(true)
    expect(storage.raw.get('taste_artists')?.has('周杰伦')).toBe(true)
    expect(result.written.taste_tracks).toBe(1)
    expect(result.written.taste_artists).toBe(1)
  })

  it('排行按分数排序，且带置信度', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    for (let i = 0; i < 6; i++) {
      await store.applyDeltas(track(`曲${i}|周杰伦`, '周杰伦'), { now: T0, halfLifeDays: 90 })
    }
    await store.applyDeltas(
      [
        { kind: 'artist', key: '金玟岐', signal: 1, reason: '一次完整播放', provenance: 'implicit' },
      ],
      { now: T0, halfLifeDays: 90 },
    )
    const top = store.top('artist', { now: T0, halfLifeDays: 90, limit: 5 })
    expect(top[0]?.key).toBe('周杰伦')
    expect(top[0]?.score).toBeGreaterThan(top[1]?.score ?? 0)
    // 档位：<5 次 low、5~20 次 medium、>20 次 high —— 6 次完整播放 = medium
    expect(top[0]?.confidence).toBe('medium')
    expect(top[1]?.confidence).toBe('low')
  })

  it('显式表态写进 explicit 且不随时间衰减', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    await store.applyDeltas([explicitDelta({ kind: 'artist', key: '金玟岐', liked: true, provenance: 'explicit-chat' })], {
      now: T0,
      halfLifeDays: 90,
    })
    const persisted = storage.raw.get('taste_artists')?.get('金玟岐') as { explicit: number }
    expect(persisted.explicit).toBe(3)
    const far = T0 + 20 * DAY * 90
    expect(store.top('artist', { now: far, halfLifeDays: 90 })[0]?.score).toBeCloseTo(3, 3)
  })

  it('实体超上限时丢弃最低分的（防止无限增长）', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    // 上限 200，造 205 个标签
    for (let i = 0; i < 205; i++) {
      await store.applyDeltas([{ kind: 'tag', key: `tag:${i}`, signal: i + 1, reason: 'x', provenance: 'implicit' }], {
        now: T0,
        halfLifeDays: 90,
      })
    }
    const size = storage.raw.get('taste_tags')?.size ?? 0
    expect(size).toBeLessThanOrEqual(200)
    // 分最低的几个应该被丢掉
    expect(storage.raw.get('taste_tags')?.has('tag:0')).toBe(false)
    expect(storage.raw.get('taste_tags')?.has('tag:204')).toBe(true)
  })

  it('坏记录被跳过并告警，不影响其它实体', () => {
    const storage = fakeStorage()
    storage.table('taste_artists').put('坏的', { kind: 'artist', key: '坏的' }) // 缺分数与 raw
    const warnings: string[] = []
    const store = new TasteStore(storage, { now: () => T0, onWarn: (m) => warnings.push(m) })
    expect(Object.keys(store.load('artist'))).toEqual([])
    expect(warnings.join()).toContain('不匹配 schema')
  })
})

describe('TasteStore：可播放引用（Tier-1）与 seen/played', () => {
  it('只确认身份（探索）→ status=seen，不算"听过"', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    await store.upsertTrackRef({ trackKey: '起风了|买辣椒也用券', title: '起风了', artist: '买辣椒也用券', music: MUSIC_TX, played: false, explored: true })
    expect(store.hasPlayed('起风了|买辣椒也用券')).toBe(false)
    expect(store.playedKeys().size).toBe(0)
    const record = storage.raw.get('taste_tracks')?.get('起风了|买辣椒也用券') as { status: string; lastExploredAt?: number }
    expect(record.status).toBe('seen')
    expect(record.lastExploredAt).toBe(T0)
  })

  it('真的播过 → status=played，并进入 playedKeys', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    await store.upsertTrackRef({ trackKey: '晴天|周杰伦', title: '晴天', artist: '周杰伦', music: MUSIC_TX, played: true })
    expect(store.hasPlayed('晴天|周杰伦')).toBe(true)
    expect([...store.playedKeys()]).toEqual(['晴天|周杰伦'])
  })

  it('played 不会被后续的 seen 覆盖（探索过不等于没听过）', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    await store.upsertTrackRef({ trackKey: 'k', title: 't', artist: 'a', music: MUSIC_TX, played: true })
    await store.upsertTrackRef({ trackKey: 'k', title: 't', artist: 'a', music: MUSIC_WY, played: false, explored: true })
    expect(store.hasPlayed('k')).toBe(true)
  })

  it('多平台引用共存，trackRef 优先最后成功播放的平台', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    await store.upsertTrackRef({ trackKey: 'k', title: 't', artist: 'a', music: MUSIC_TX, played: true, resolved: true })
    await store.upsertTrackRef({ trackKey: 'k', title: 't', artist: 'a', music: MUSIC_WY, played: true, resolved: true })
    expect(store.trackRef('k')?.source).toBe('wy')
    const record = storage.raw.get('taste_tracks')?.get('k') as { refs: Record<string, unknown> }
    expect(Object.keys(record.refs).sort()).toEqual(['tx', 'wy'])
  })

  it('trackRef 拿到的就是可直接喂 resolveUrl 的完整 MusicInfo', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    await store.upsertTrackRef({ trackKey: 'k', title: 't', artist: 'a', music: MUSIC_TX, played: true, resolved: true, scriptName: 'HYWmusic' })
    const ref = store.trackRef('k')
    expect(ref?.music.id).toBe(MUSIC_TX.id)
    expect(ref?.music.meta.albumName).toBe('叶惠美')
    const stored = storage.raw.get('taste_tracks')?.get('k') as { refs: { tx: { lastScript?: string; lastResolvedAt?: number } } }
    expect(stored.refs.tx.lastScript).toBe('HYWmusic')
    expect(stored.refs.tx.lastResolvedAt).toBe(T0)
  })

  it('未知曲目返回 undefined', () => {
    const store = new TasteStore(fakeStorage(), { now: () => T0 })
    expect(store.trackRef('不存在')).toBeUndefined()
  })
})

describe('TasteStore：事件流（唯一真源）', () => {
  it('同一天的事件合并进同一个桶（per-record 下不产生几千个小文件）', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    await store.appendEvent({ kind: 'settle', origin: 'user', mode: 'replay', ts: T0, trackKey: 'a|b' })
    await store.appendEvent({ kind: 'settle', origin: 'ai', mode: 'explore', ts: T0 + 1000, trackKey: 'c|d' })
    const key = dayKey(T0)
    expect([...storage.raw.get('taste_events')!.keys()]).toEqual([key])
    const bucket = storage.raw.get('taste_events')!.get(key) as { events: unknown[] }
    expect(bucket.events).toHaveLength(2)
  })

  it('事件带 deltas（可解释"为什么"）', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    const deltas = track('晴天|周杰伦', '周杰伦')
    await store.appendEvent({ kind: 'settle', origin: 'user', mode: 'replay', ts: T0, trackKey: '晴天|周杰伦', playedRatio: 1, deltas })
    const bucket = storage.raw.get('taste_events')!.get(dayKey(T0)) as { events: Array<{ deltas?: unknown[] }> }
    expect(bucket.events[0]?.deltas).toHaveLength(deltas.length)
  })

  it('单日超过上限时丢弃最旧的', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    for (let i = 0; i < MAX_EVENTS_PER_DAY + 5; i++) {
      await store.appendEvent({ kind: 'settle', origin: 'user', mode: 'replay', ts: T0 + i, trackKey: `k${i}` })
    }
    const bucket = storage.raw.get('taste_events')!.get(dayKey(T0)) as { events: Array<{ trackKey?: string }> }
    expect(bucket.events).toHaveLength(MAX_EVENTS_PER_DAY)
    expect(bucket.events[0]?.trackKey).toBe('k5') // 最旧的 5 条被丢掉
  })

  it('读取按时间升序，并按保留窗口过滤', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    await store.appendEvent({ kind: 'settle', origin: 'user', mode: 'replay', ts: T0 + 500, trackKey: 'later' })
    await store.appendEvent({ kind: 'settle', origin: 'user', mode: 'replay', ts: T0, trackKey: 'earlier' })
    const kept = store.readEvents({ now: T0 + 1000, retainDays: 90 })
    expect(kept.map((e) => e.trackKey)).toEqual(['earlier', 'later'])

    const none = store.readEvents({ now: T0 + 200 * DAY, retainDays: 90 })
    expect(none).toHaveLength(0)
  })

  it('裁剪删掉窗口外的日期桶（键就是日期，字符串比较即可）', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    storage.table('taste_events').put('2020-01-01', { date: '2020-01-01', events: [] })
    storage.table('taste_events').put(dayKey(T0), { date: dayKey(T0), events: [] })
    const removed = await store.pruneEvents({ now: T0, retainDays: 90 })
    expect(removed).toEqual(['2020-01-01'])
    expect([...storage.raw.get('taste_events')!.keys()]).toEqual([dayKey(T0)])
  })
})

describe('TasteStore：状态与清空', () => {
  it('摘要状态读写', async () => {
    const store = new TasteStore(fakeStorage(), { now: () => T0 })
    await store.writeState({ summary: '近 90 天常听：周杰伦', topArtists: ['周杰伦'], sampleSize: 3, generatedAt: T0 })
    const state = store.readState()
    expect(state.summary).toContain('周杰伦')
    expect(state.sampleSize).toBe(3)
  })

  it('探索/复听分别计数（分组评估与自适应探索率依赖它）', async () => {
    const store = new TasteStore(fakeStorage(), { now: () => T0 })
    await store.bumpExploreStats('replay', 'play', 0.2)
    await store.bumpExploreStats('explore', 'skip', 0.2)
    const stats = store.readState().exploreStats
    expect(stats?.replayPlays).toBe(1)
    expect(stats?.exploreSkips).toBe(1)
    expect(stats?.explorePlays).toBe(0)
  })

  it('clear 清空全部画像表', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    await store.applyDeltas(track('晴天|周杰伦', '周杰伦'), { now: T0, halfLifeDays: 90 })
    await store.upsertTrackRef({ trackKey: 'k', title: 't', artist: 'a', music: MUSIC_TX, played: true })
    await store.appendEvent({ kind: 'settle', origin: 'user', mode: 'replay', ts: T0, trackKey: 'k' })
    await store.writeState({ summary: 'x' })

    await store.clear()
    for (const table of ['taste_tracks', 'taste_artists', 'taste_events', 'taste_state']) {
      expect(storage.raw.get(table)?.size ?? 0).toBe(0)
    }
    expect(Object.keys(store.load('artist'))).toEqual([]) // 缓存也要失效
  })
})

describe('写入形状 vs domain schema（形状漂移的正面锁）', () => {
  it('store 真实写出的每一条记录都能被 domain schema 接受', async () => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })

    // 走一遍所有写路径
    await store.applyDeltas(
      [
        ...track('晴天|周杰伦', '周杰伦'),
        explicitDelta({ kind: 'artist', key: '金玟岐', liked: true, provenance: 'explicit-chat' }),
        { kind: 'tag', key: 'platform:tx', signal: 0.5, reason: '平台', provenance: 'implicit' },
        { kind: 'strategy', key: 'strategy:frustrated', signal: -0.5, reason: '策略', provenance: 'implicit' },
      ],
      { now: T0, halfLifeDays: 90 },
    )
    await store.upsertTrackRef({
      trackKey: '晴天|周杰伦',
      title: '晴天',
      artist: '周杰伦',
      music: MUSIC_TX,
      album: '叶惠美',
      durationSec: 269,
      variant: 'original',
      played: true,
      resolved: true,
      scriptName: 'HYWmusic',
    })
    await store.upsertTrackRef({ trackKey: '新的歌|新人', title: '新的歌', artist: '新人', music: MUSIC_WY, played: false, explored: true })
    await store.appendEvent({ kind: 'settle', origin: 'ai', mode: 'explore', ts: T0, trackKey: '新的歌|新人', artistKey: '新人', playedRatio: 0.1, context: 'stuck', deltas: track('新的歌|新人', '新人') })
    await store.writeState({ summary: 'x', exploreStats: { replayPlays: 0, replaySkips: 0, explorePlays: 0, exploreSkips: 1, exploreRatio: 0.2 } })

    const schemas: Record<string, { safeParse(v: unknown): { success: boolean } }> = {
      taste_events: domainSpec.tables.taste_events.valueSchema,
      taste_tracks: domainSpec.tables.taste_tracks.valueSchema,
      taste_artists: domainSpec.tables.taste_artists.valueSchema,
      taste_tags: domainSpec.tables.taste_tags.valueSchema,
      taste_state: domainSpec.tables.taste_state.valueSchema,
    }

    let checked = 0
    for (const [table, rows] of storage.raw) {
      const schema = schemas[table]
      expect(schema).toBeDefined()
      for (const [key, value] of rows) {
        const parsed = schema!.safeParse(value)
        if (!parsed.success) {
          throw new Error(`写入形状不被 domain schema 接受: ${table}/${key} → ${JSON.stringify(parsed)}`)
        }
        checked += 1
      }
    }
    expect(checked).toBeGreaterThan(4)
  })
})
