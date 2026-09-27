// 探索（跳出已听、但仍在喜好范围内）—— 候选筛选与排序（纯函数）。
//
// 设计要点（docs/design-taste-memory.md §18.2）：
//   - 候选来源 ①「同艺人未听曲目」：按常听艺人的名字搜索，天然落在喜好范围内，**不需要标签**
//     （所以 P0 就能上；细粒度标签与跨艺人探索放 P1）。
//   - **见过的 ≠ 听过的**：只排除真的播过（played）与冷却期内的，确认过但没听的仍可再推。
//   - **去重窗口**：同一首歌在一段时间内不重复探索（否则用户会觉得"怎么又是这首"）。
//   - **版本过滤**：探索不该把翻唱/Live 当成"新歌"推给用户（spike #5b 的教训）。
//   - **多样性**：跨种子艺人轮流取（round-robin），避免一次探索全推同一位艺人。

import { detectVariant, normalizeArtist, secondsFromInterval, trackKey as makeKey } from './normalize'

/** 同一首歌在多长时间内不重复探索（天）。 */
export const EXPLORE_COOLDOWN_DAYS = 60

/** 一次探索最多用几个种子艺人（每个种子一次搜索，控制网络与延迟）。 */
export const EXPLORE_MAX_SEEDS = 3

/** 每次探索最多给几个候选。 */
export const EXPLORE_MAX_CANDIDATES = 8

export interface ExploreSeed {
  /** 归一化艺人 key。 */
  key: string
  /** 展示用原文（搜索时用它）。 */
  raw: string
  score: number
  confidence: string
}

/** 搜索结果（只需这几个字段，便于纯函数测试）。 */
export interface ExploreSearchItem {
  name: string
  singer: string
  source: string
  id: string
  albumName?: string
  interval?: string
}

export interface ExploreCandidate {
  title: string
  artist: string
  source: string
  id: string
  album?: string
  durationSec?: number
  score: number
  reason: string
}

export interface RankExploreOptions {
  seeds: readonly ExploreSeed[]
  /** 每个种子艺人的搜索结果（key = 归一化艺人 key）。 */
  resultsBySeed: ReadonlyMap<string, readonly ExploreSearchItem[]>
  /** 真的播过的曲目 key（`曲名|艺人`）。 */
  playedKeys: ReadonlySet<string>
  /** 冷却期内探索过的曲目 key。 */
  recentlyExplored: ReadonlySet<string>
  limit?: number
}

/**
 * 从"同艺人搜索结果"里挑出没听过的候选。
 *
 * 排序：先按种子艺人的权重（更常听的优先），再按搜索结果里的位置；
 * 然后**跨种子轮流取**保证多样性。同一首歌只出现一次。
 */
export function rankUnheardCandidates(options: RankExploreOptions): ExploreCandidate[] {
  const limit = Math.max(1, options.limit ?? EXPLORE_MAX_CANDIDATES)
  const buckets: ExploreCandidate[][] = []
  const seenKeys = new Set<string>()

  for (const seed of options.seeds) {
    const items = options.resultsBySeed.get(seed.key) ?? []
    const bucket: ExploreCandidate[] = []
    for (const item of items) {
      const key = makeKey(item.name, item.singer)
      if (options.playedKeys.has(key)) continue // 已经听过
      if (options.recentlyExplored.has(key)) continue // 冷却期内
      if (seenKeys.has(key)) continue // 本次已入选
      // 探索不该把翻唱/Live 当新歌推给用户
      if (detectVariant({ name: item.name, ...(item.albumName ? { albumName: item.albumName } : {}) }) !== 'original') continue
      // 搜索可能返回别的艺人（关键词模糊匹配），只保留种子艺人的作品
      if (normalizeArtist(item.singer) !== seed.key) continue
      const duration = secondsFromInterval(item.interval)
      seenKeys.add(key)
      bucket.push({
        title: item.name,
        artist: item.singer,
        source: item.source,
        id: item.id,
        ...(item.albumName ? { album: item.albumName } : {}),
        ...(duration !== undefined ? { durationSec: duration } : {}),
        score: seed.score,
        reason: `没听过的${seed.raw}`,
      })
    }
    if (bucket.length > 0) buckets.push(bucket)
  }

  // 跨种子轮流取（多样性）
  const ranked: ExploreCandidate[] = []
  let index = 0
  while (ranked.length < limit) {
    let picked = false
    for (const bucket of buckets) {
      const next = bucket[index]
      if (next) {
        ranked.push(next)
        picked = true
        if (ranked.length >= limit) break
      }
    }
    if (!picked) break
    index += 1
  }
  return ranked
}
