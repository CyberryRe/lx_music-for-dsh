// 画像相关表的持久层 schema（domain `lx_music` 的新增表）。
//
// 这些 schema 是**持久层读边界校验**：任一条记录不匹配都会让整个 `open` 失败
// （1.2.0 起会 backup-and-skip，但仍是噪音与数据丢失）。因此必须与 store.ts 实际写入的
// 形状逐字段一致 —— tests/taste-schema.test.ts 直接把真实写入形状喂给这些 schema 来锁死。
//
// 两个刻意的设计：
//   1. `taste_events` **按天分桶**（一条记录 = 一天的数组）。per-record 布局下如果一条事件
//      一个文件，几千条事件就是几千个小文件；按天分桶后是"每天一个文件"，裁剪也只是删键。
//   2. `MusicInfo` 的 `meta` 用 catchall：各平台会带各自的私有字段（hash/copyrightId/
//      strMediaMid/…），先把它们原样存住（Tier-1 直取要用），但顶层结构保持严格。

import { z as zod } from 'zod'
import type { MusicInfo } from '../shared/types'

export const musicSourceSchema = zod.enum(['kw', 'wy', 'kg', 'tx', 'mg', 'local'])

const musicQualitySchema = zod.object({
  type: zod.enum(['128k', '320k', 'flac', 'flac24bit', 'flac32bit', 'wav']),
  size: zod.string().nullable().optional(),
})

const musicMetaSchema = zod
  .object({
    songId: zod.union([zod.string(), zod.number()]),
    albumName: zod.string().optional(),
    albumId: zod.union([zod.string(), zod.number()]).optional(),
    picUrl: zod.string().nullable().optional(),
    qualitys: zod.array(musicQualitySchema).optional(),
  })
  .catchall(zod.unknown())

/** 完整可播放曲目（Tier-1 直取用：拿它直接喂 provider.resolveUrl，无需重新搜索）。 */
export const musicInfoSchema = zod.object({
  id: zod.string(),
  name: zod.string(),
  singer: zod.string(),
  source: musicSourceSchema,
  interval: zod.string().nullable(),
  meta: musicMetaSchema,
})

export type StoredMusicInfo = zod.infer<typeof musicInfoSchema>
// 编译期确认方向很重要：**代码里当作 MusicInfo 写入的对象，一定能被 schema 接受**。
// 1.0.1 的事故就是反过来的（schema 比实际写入更严格 → 整条记录不可读 → 整个 domain 打不开）。
//   - 顶层字段在这里逐字段锁死；
//   - `meta` 因为带 catchall（保留各平台私有字段 hash/copyrightId/strMediaMid…）而有索引签名，
//     TS 接口无法赋值给带索引签名的类型，所以改由 tests/taste-schema.test.ts 用真实
//     MusicInfo（含私有字段）做运行时校验——那比类型断言更强。
const _writable: Omit<StoredMusicInfo, 'meta'> & { meta: unknown } = {} as MusicInfo
void _writable

/** 实体分数（聚合层通用部分）。 */
const scoreFields = {
  implicit: zod.number(),
  explicit: zod.number(),
  plays: zod.number(),
  skips: zod.number(),
  lastTs: zod.number(),
  updatedAt: zod.number(),
}

/** 一条信号（事件的派生产物，保留它才能解释"为什么"）。 */
export const entityDeltaSchema = zod.object({
  kind: zod.enum(['track', 'artist', 'tag', 'strategy']),
  key: zod.string(),
  signal: zod.number(),
  reason: zod.string(),
  provenance: zod.enum(['implicit', 'explicit-chat', 'explicit-ui']),
  /** 是否计入样本量（意图类信号为 false）。 */
  sample: zod.boolean().optional(),
})

/** 一条原始事件（终态结算的输入 + 结算结果，事件流是唯一真源）。 */
export const tasteEventSchema = zod.object({
  ts: zod.number(),
  kind: zod.enum(['play', 'settle', 'like', 'dislike', 'forget', 'note', 'search-miss']),
  origin: zod.enum(['user', 'ai', 'playlist']),
  mode: zod.enum(['replay', 'explore']),
  trackKey: zod.string().optional(),
  artistKey: zod.string().optional(),
  title: zod.string().optional(),
  artist: zod.string().optional(),
  source: zod.string().optional(),
  quality: zod.string().optional(),
  playedRatio: zod.number().optional(),
  replayed: zod.boolean().optional(),
  context: zod.string().optional(),
  deltas: zod.array(entityDeltaSchema).optional(),
})

/** 事件表按天分桶。 */
export const tasteEventDaySchema = zod.object({
  date: zod.string(),
  events: zod.array(tasteEventSchema),
})

/** 曲目的平台标识（一个曲目可挂多个平台的 id，互相兜底）。 */
export const trackRefSchema = zod.object({
  music: musicInfoSchema,
  lastOkAt: zod.number().optional(),
  lastResolvedAt: zod.number().optional(),
  lastScript: zod.string().optional(),
})

export const storedTrackSchema = zod.object({
  kind: zod.literal('track'),
  key: zod.string(),
  title: zod.string(),
  artist: zod.string(),
  ...scoreFields,
  /** seen = 只确认过身份（探索/严格匹配通过但没播）；played = 真的播过。探索池依赖这个区分。 */
  status: zod.enum(['seen', 'played']),
  variant: zod.enum(['original', 'live', 'cover', 'instrumental', 'remix', 'unknown']).optional(),
  album: zod.string().optional(),
  durationSec: zod.number().optional(),
  lastSource: zod.string().optional(),
  refs: zod.record(zod.string(), trackRefSchema).optional(),
  lastPlayedAt: zod.number().optional(),
  lastExploredAt: zod.number().optional(),
})

export const storedArtistSchema = zod.object({
  kind: zod.literal('artist'),
  key: zod.string(),
  raw: zod.string(),
  ...scoreFields,
  facets: zod.array(zod.string()).optional(),
})

export const storedTagSchema = zod.object({
  kind: zod.enum(['tag', 'strategy']),
  key: zod.string(),
  ...scoreFields,
  label: zod.string().optional(),
  raw: zod.string().optional(),
})

export const exploreStatsSchema = zod.object({
  replayPlays: zod.number(),
  replaySkips: zod.number(),
  explorePlays: zod.number(),
  exploreSkips: zod.number(),
  exploreRatio: zod.number(),
})

export const tasteStateSchema = zod.object({
  summary: zod.string().optional(),
  topArtists: zod.array(zod.string()).optional(),
  sampleSize: zod.number().optional(),
  generatedAt: zod.number().optional(),
  exploreStats: exploreStatsSchema.optional(),
})

export type StoredTrack = zod.infer<typeof storedTrackSchema>
export type StoredArtist = zod.infer<typeof storedArtistSchema>
export type StoredTag = zod.infer<typeof storedTagSchema>
export type StoredEventDay = zod.infer<typeof tasteEventDaySchema>
export type TasteEventRecord = zod.infer<typeof tasteEventSchema>
export type TasteStateRecord = zod.infer<typeof tasteStateSchema>
export type ExploreStats = zod.infer<typeof exploreStatsSchema>
