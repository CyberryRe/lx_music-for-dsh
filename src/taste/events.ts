// 画像事件层（L0）：事件的种类/来源/信号权重，以及"播放终态结算"。
//
// 设计要点（docs/design-taste-memory.md §3、§18.2）：
//   - 只有**终态**事件才落库（曲目结束或被切走），`reportProgress` 那种 1 秒一次的高频
//     信号只在内存里折算比例。写入频率 = O(点歌次数)。
//   - 归因三拆：曲目 / 艺人 / 策略。AI 放的歌被切走，多半是"这次不想听这首"，不等于讨厌
//     艺人；而"AI 在这个情绪下选错类型"应该反馈给推荐策略，不是反馈给艺人。
//   - 探索曲的负反馈额外打折：否则几次探索失败就把新艺人永久压低（反向茧房）。
//   - 本模块是纯函数，不碰存储、不碰时间（时间由调用方传入），便于单测与重算。

/** 事件种类。 */
export type TasteEventKind = 'play' | 'settle' | 'like' | 'dislike' | 'forget' | 'note' | 'search-miss'

/** 谁发起的这次播放：用户 / AI / 播放列表自动续播。 */
export type TasteEventOrigin = 'user' | 'ai' | 'playlist'

/** 这次是复听还是探索（探索的指标要分开统计）。 */
export type TasteEventMode = 'replay' | 'explore'

/** 信号来源：隐式（行为推断）/ 显式（用户在 UI 或对话里说的）。 */
export type TasteProvenance = 'implicit' | 'explicit-chat' | 'explicit-ui'

/** 信号落到哪一类实体上。 */
export type TasteEntityKind = 'track' | 'artist' | 'tag' | 'strategy'

/** 一条待应用的信号（纯数据，可直接进事件表）。 */
export interface EntityDelta {
  kind: TasteEntityKind
  /** 归一化后的实体 key（艺人名 / `曲名|艺人` / 标签 / 策略名）。 */
  key: string
  signal: number
  /** 可解释文案，用于 UI 与工具输出（"完整播放" / "15 秒内切走（AI 放的）"）。 */
  reason: string
  provenance: TasteProvenance
}

/** 信号权重表（全部可配；这里是默认值）。 */
export const SIGNAL = {
  /** 完整播放（比例 ≥ COMPLETE_RATIO）。 */
  complete: 2,
  /** 部分播放（PARTIAL_RATIO ≤ 比例 < COMPLETE_RATIO）。 */
  partial: 0.5,
  /** 手动重播 / 单曲循环。 */
  replay: 1.5,
  /** 明确点歌（origin=user）的意图分。 */
  intent: 1,
  /** 加入列表但没播。 */
  queued: 0.2,
  /** 用户自己点的歌，15 秒内切走。 */
  skipUser: -1.5,
  /** AI 放的歌被切走：曲目维度。 */
  skipAiTrack: -1,
  /** AI 放的歌被切走：艺人维度（大幅打折，见归因三拆）。 */
  skipAiArtist: -0.3,
  /** AI 放的歌被切走：策略维度（该情绪/情境下选得不好）。 */
  skipAiStrategy: -0.5,
  /** 搜索后没选任何结果就改了 query。 */
  searchMiss: -0.3,
  /** 显式"我喜欢"（UI 或对话）。 */
  explicitLike: 3,
  /** 显式"我不喜欢"。 */
  explicitDislike: -3,
} as const

/** 完整播放的判定阈值。 */
export const COMPLETE_RATIO = 0.8
/** 部分播放的判定阈值（低于它视为切走）。 */
export const PARTIAL_RATIO = 0.3
/** 探索曲负反馈的额外折扣（反向茧房防护）。 */
export const EXPLORE_SKIP_DISCOUNT = 0.25
/** AI 归因下"艺人"维度的折扣（AI 放的不等于用户想听的）。 */
export const AI_ARTIST_DISCOUNT = 0.3

// ---------------------------------------------------------------------------
// 标签 key 构造器（taste_tags 的命名规范，集中在这里以免各处手写字符串）
// ---------------------------------------------------------------------------

export function platformTag(source: string): string {
  return `platform:${source}`
}

export function qualityTag(quality: string): string {
  return `quality:${quality}`
}

/** 时段标签：深夜/早晨/白天/傍晚（本地时间）。 */
export function hourTag(ts: number, timezoneOffsetMinutes = new Date(ts).getTimezoneOffset()): string {
  // getTimezoneOffset 是"UTC - 本地"的分钟数，所以本地小时 = UTC 小时 - offset/60
  const localHour = new Date(ts - timezoneOffsetMinutes * 60_000).getUTCHours()
  if (localHour >= 23 || localHour < 5) return 'hour:night'
  if (localHour < 9) return 'hour:morning'
  if (localHour < 17) return 'hour:day'
  return 'hour:evening'
}

export function moodTag(mood: string): string {
  return `mood:${mood}`
}

/** "某情绪下常听某艺人"——情绪与艺人的组合标签（§18.2 的探索范围定义要用）。 */
export function moodArtistTag(mood: string, artistKey: string): string {
  return `mood:${mood}@artist:${artistKey}`
}

// ---------------------------------------------------------------------------
// 终态结算
// ---------------------------------------------------------------------------

/** 一次播放会话的终态摘要（由 PlaybackService 在曲目结束/被切走时构造）。 */
export interface PlaySession {
  /** 归一化前的原始曲名/歌手（结算时会各自归一化）。 */
  title: string
  artist: string
  /** 曲目归一化 key（`曲名|艺人`），由调用方用 normalize.trackKey 得出。 */
  trackKey: string
  /** 艺人归一化 key。 */
  artistKey: string
  source?: string
  quality?: string
  origin: TasteEventOrigin
  mode: TasteEventMode
  /** 播放比例 0~1（已播放时长 / 总时长）。 */
  playedRatio: number
  /** 是否是重播/单曲循环触发的重复播放。 */
  replayed?: boolean
  /** 情境（来自 skill 的情绪语义，如 frustrated/stuck/happy/focused）。 */
  context?: string
  ts: number
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000
}

/**
 * 把一次播放结算成一组待应用的信号。
 *
 * 规则（docs/design-taste-memory.md §3 的信号表）：
 *   - 比例 ≥ 0.8 → 完整播放：曲目/艺人各 +2.0
 *   - 0.3 ≤ 比例 < 0.8 → 部分播放：各 +0.5
 *   - 比例 < 0.3 → 切走：用户点的 −1.5；AI 放的则曲目 −1.0、艺人 −0.3、策略 −0.5
 *   - 探索曲的负反馈再乘 0.25
 *   - 重播额外 +1.5
 *   - 带 context 且完整播放 → 记 `mood:<情境>@artist:<艺人>` 的关联信号（学"一烦就听谁"）
 */
export function settlePlaySession(session: PlaySession): EntityDelta[] {
  const deltas: EntityDelta[] = []
  const push = (kind: TasteEntityKind, key: string, signal: number, reason: string): void => {
    if (signal === 0) return
    deltas.push({ kind, key, signal, reason, provenance: 'implicit' })
  }

  const ratio = Number.isFinite(session.playedRatio) ? Math.min(1, Math.max(0, session.playedRatio)) : 0
  const explore = session.mode === 'explore'
  const exploreNote = explore ? '（探索）' : ''

  if (ratio >= COMPLETE_RATIO) {
    push('track', session.trackKey, SIGNAL.complete, `完整播放${exploreNote}`)
    push('artist', session.artistKey, SIGNAL.complete, `完整播放${exploreNote}`)
    if (session.context) {
      push('tag', moodArtistTag(session.context, session.artistKey), SIGNAL.complete, `完整播放（情境 ${session.context}）`)
    }
  } else if (ratio >= PARTIAL_RATIO) {
    push('track', session.trackKey, SIGNAL.partial, `播放 ${Math.round(ratio * 100)}%${exploreNote}`)
    push('artist', session.artistKey, SIGNAL.partial, `播放 ${Math.round(ratio * 100)}%${exploreNote}`)
  } else {
    const label = `${Math.round(ratio * 100)}% 切走`
    if (session.origin === 'user') {
      push('track', session.trackKey, SIGNAL.skipUser, `${label}（用户点的）`)
      push('artist', session.artistKey, SIGNAL.skipUser, `${label}（用户点的）`)
    } else {
      const factor = explore ? EXPLORE_SKIP_DISCOUNT : 1
      push('track', session.trackKey, round3(SIGNAL.skipAiTrack * factor), `${label}（AI 放的）${exploreNote}`)
      push('artist', session.artistKey, round3(SIGNAL.skipAiArtist * factor), `${label}（AI 放的，艺人维度打折）${exploreNote}`)
      if (session.context) {
        push('strategy', `strategy:${session.context}`, round3(SIGNAL.skipAiStrategy * factor), `${label}（情境 ${session.context} 选题不佳）`)
      }
    }
  }

  if (session.replayed) {
    push('track', session.trackKey, SIGNAL.replay, '重播 / 单曲循环')
    push('artist', session.artistKey, SIGNAL.replay, '重播 / 单曲循环')
  }

  return deltas
}

/** 播放意图（加入列表 / 明确点歌）产生的信号。 */
export function intentDeltas(options: {
  trackKey: string
  artistKey: string
  origin: TasteEventOrigin
  source?: string
  ts: number
}): EntityDelta[] {
  const deltas: EntityDelta[] = [
    { kind: 'track', key: options.trackKey, signal: SIGNAL.queued, reason: '加入播放列表', provenance: 'implicit' },
  ]
  if (options.origin === 'user') {
    deltas.push({ kind: 'track', key: options.trackKey, signal: SIGNAL.intent, reason: '用户明确点歌', provenance: 'implicit' })
    deltas.push({ kind: 'artist', key: options.artistKey, signal: SIGNAL.intent, reason: '用户明确点歌', provenance: 'implicit' })
  }
  if (options.source) {
    deltas.push({ kind: 'tag', key: platformTag(options.source), signal: SIGNAL.queued, reason: '命中的平台', provenance: 'implicit' })
  }
  return deltas
}

/** 显式表态（UI 或对话）产生的信号——走 explicit，不参与时间衰减。 */
export function explicitDelta(options: {
  kind: TasteEntityKind
  key: string
  liked: boolean
  provenance: Exclude<TasteProvenance, 'implicit'>
  note?: string
}): EntityDelta {
  const signal = options.liked ? SIGNAL.explicitLike : SIGNAL.explicitDislike
  const base = options.liked ? '显式喜欢' : '显式不喜欢'
  return {
    kind: options.kind,
    key: options.key,
    signal,
    reason: options.note ? `${base}：${options.note}` : base,
    provenance: options.provenance,
  }
}

/** 搜索后没选任何结果就改 query → 对平台/来源的负反馈。 */
export function searchMissDelta(source: string): EntityDelta {
  return { kind: 'tag', key: platformTag(source), signal: SIGNAL.searchMiss, reason: '搜索后未选就改 query', provenance: 'implicit' }
}
