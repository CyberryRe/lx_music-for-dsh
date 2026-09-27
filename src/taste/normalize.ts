// 实体归一化与版本识别（纯函数）。
//
// 为什么必须有：证据一旦被切碎，画像就失真。同一首歌/同一位艺人在不同平台、不同写法下
// 会呈现成不同字符串：
//   - 曲名后缀：`晴天 (Live)` / `晴天 (伴奏)` / `晴天 (原唱 周杰伦) - RyaVocal` / `晴天（女声版）`
//   - 艺人写法：`周杰伦` / `Jay` / `周杰伦 / 杨瑞代`（多人合唱）
//   - 全角半角、大小写、空白与标点
// 实测数据见 docs/design-taste-memory.md §2（spike #5）：只搜"晴天"时网易云前 6 条**全是翻唱**，
// 所以"能区分原唱/Live/翻唱"是 Tier-2 严格校验成立的前提。
//
// 版本判别的两个强依据（spike #5b 实测）：
//   - `albumName`：原唱晴天在专辑《叶惠美》；Live 版在《…世界巡回演唱会》/《2004 无与伦比…》
//   - `interval`：原唱 04:29/04:30；Live 版 04:09/04:59

/** 版本类型。 */
export type VariantKind = 'original' | 'live' | 'cover' | 'instrumental' | 'remix' | 'unknown'

/** 版本优先级（越大越优先）——Tier-2 在多个候选中挑"最像原唱"的那个。 */
export const VARIANT_PRIORITY: Record<VariantKind, number> = {
  original: 3,
  unknown: 2,
  live: 1.5,
  remix: 1,
  cover: 0.5,
  instrumental: 0.5,
}

const FULLWIDTH_OFFSET = 0xfee0

/** 全角 → 半角（含全角空格）。 */
export function toHalfWidth(input: string): string {
  let out = ''
  for (const ch of input) {
    const code = ch.codePointAt(0) ?? 0
    if (code === 0x3000) out += ' '
    else if (code >= 0xff01 && code <= 0xff5e) out += String.fromCodePoint(code - FULLWIDTH_OFFSET)
    else out += ch
  }
  return out
}

/** 归一化基础文本：全角转半角 → 小写 → 去掉空白与常见标点。 */
export function normalizeText(input: string): string {
  return toHalfWidth(String(input ?? ''))
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・.,，。!！?？'"“”‘’()（）[\]【】<>《》\-_~—–|/\\+&%$#@*:：;；]/g, '')
}

/** 版本关键词（出现在曲名或专辑名里）。 */
const VARIANT_PATTERNS: ReadonlyArray<{ kind: VariantKind; pattern: RegExp }> = [
  { kind: 'instrumental', pattern: /伴奏|instrumental|off\s*vocal|karaoke|纯音乐|演奏版/i },
  { kind: 'live', pattern: /live|演唱会|现场|concert|tour/i },
  { kind: 'remix', pattern: /remix|dj\s*版|混音|mashup|bootleg/i },
  { kind: 'cover', pattern: /翻唱|cover|原唱\s*[^)）]*\)|女声版|男声版|深情版|童声/i },
]

/** 曲名里需要剥掉的"版本/附注"后缀，例如 `晴天 (Live)`、`圣诞星（feat. 杨瑞代）`。 */
const TITLE_SUFFIX_PATTERN =
  /[(（[【][^)）\]】]*(live|演唱会|现场|伴奏|纯音乐|instrumental|remix|混音|翻唱|cover|女声|男声|深情|童声|dj|feat\.?|ft\.?|合唱|对唱|原唱|重制|remaster|demo|acoustic|不插电)[^)）\]】]*[)）\]】]/gi

/**
 * 归一化曲名：剥掉括号里的版本/附注后缀，再走基础归一化。
 * 例：`晴天 (Live)` → `晴天`；`圣诞星（feat. 杨瑞代）` → `圣诞星`
 */
export function normalizeTitle(title: string): string {
  const stripped = toHalfWidth(String(title ?? '')).replace(TITLE_SUFFIX_PATTERN, '')
  return normalizeText(stripped)
}

/**
 * 归一化艺人：多人合唱（`A / B`、`A、B`、`A feat. B`）取**主艺人**，再走基础归一化。
 * 例：`周杰伦 / 杨瑞代` → `周杰伦`
 */
export function normalizeArtist(artist: string): string {
  const primary = toHalfWidth(String(artist ?? ''))
    .split(/[/、,，&]|\sfeat\.?\s|\sft\.?\s|\swith\s/i)[0]
  return normalizeText(primary ?? '')
}

/** 曲目 key：`归一化曲名|归一化艺人`（taste_tracks 的主键）。 */
export function trackKey(title: string, artist: string): string {
  return `${normalizeTitle(title)}|${normalizeArtist(artist)}`
}

/** `04:29` / `1:02:03` → 秒。解析不了返回 undefined。 */
export function secondsFromInterval(interval: string | undefined | null): number | undefined {
  if (!interval) return undefined
  const parts = String(interval)
    .trim()
    .split(':')
    .map((p) => Number.parseInt(p, 10))
  if (parts.some((n) => !Number.isFinite(n) || n < 0)) return undefined
  if (parts.length === 2) return parts[0]! * 60 + parts[1]!
  if (parts.length === 3) return parts[0]! * 3600 + parts[1]! * 60 + parts[2]!
  return undefined
}

/** 版本识别：看曲名与专辑名里的关键词。 */
export function detectVariant(input: { name?: string; albumName?: string }): VariantKind {
  const haystack = `${input.name ?? ''} ${input.albumName ?? ''}`
  for (const { kind, pattern } of VARIANT_PATTERNS) {
    if (pattern.test(haystack)) return kind
  }
  return 'original'
}

/** Tier-2 严格校验的请求侧描述。 */
export interface MatchRequest {
  title: string
  artist?: string
  album?: string
  durationSec?: number
  /** 显式指定要哪个版本；不指定表示"优先原唱"。 */
  variant?: VariantKind
}

/** 候选侧（来自 SDK 搜索结果）。 */
export interface MatchCandidate {
  name: string
  singer: string
  albumName?: string
  interval?: string
}

export interface MatchOutcome {
  ok: boolean
  score: number
  variant: VariantKind
  reasons: string[]
}

/** 时长容差（秒）：超过它视为不同版本（实测原唱 04:29 vs Live 04:09 差距明显）。 */
export const DEFAULT_DURATION_TOLERANCE_SEC = 5

/**
 * 严格匹配一个候选是否就是用户/模型点名的那首歌。
 *
 * 规则（docs/design-taste-memory.md §7）：
 *   1. 归一化后曲名必须相等（`晴天 (Live)` 归一后也是 `晴天`）
 *   2. 给了艺人的话，归一化后必须相等（主艺人比对，`周杰伦 / 杨瑞代` 视为周杰伦）
 *   3. 给了专辑/时长则作为加分与硬约束（时长超容差直接不通过）
 *   4. 版本优先级：原唱 > Live > remix > 翻唱/伴奏；请求未指定版本时优先原唱，
 *      **但不会把翻唱当成原唱放出去**（这正是"搜索不能替用户选歌"的落点）
 */
export function strictMatch(
  request: MatchRequest,
  candidate: MatchCandidate,
  options: { durationToleranceSec?: number } = {},
): MatchOutcome {
  const reasons: string[] = []
  const wantedTitle = normalizeTitle(request.title)
  const gotTitle = normalizeTitle(candidate.name)
  const variant = detectVariant({ name: candidate.name, albumName: candidate.albumName })

  if (!wantedTitle || wantedTitle !== gotTitle) {
    reasons.push(`曲名不一致（${request.title} ≠ ${candidate.name}）`)
    return { ok: false, score: 0, variant, reasons }
  }

  if (request.artist) {
    const wantedArtist = normalizeArtist(request.artist)
    const gotArtist = normalizeArtist(candidate.singer)
    if (wantedArtist && wantedArtist !== gotArtist) {
      reasons.push(`艺人不一致（${request.artist} ≠ ${candidate.singer}）`)
      return { ok: false, score: 0, variant, reasons }
    }
  }

  const tolerance = options.durationToleranceSec ?? DEFAULT_DURATION_TOLERANCE_SEC
  const wantedSec = request.durationSec
  const gotSec = secondsFromInterval(candidate.interval)
  let durationScore = 0
  if (wantedSec !== undefined && gotSec !== undefined) {
    const diff = Math.abs(wantedSec - gotSec)
    if (diff > tolerance) {
      reasons.push(`时长不符（${gotSec}s vs ${wantedSec}s，容差 ${tolerance}s）`)
      return { ok: false, score: 0, variant, reasons }
    }
    durationScore = Math.max(0, 1 - diff / tolerance)
    reasons.push(`时长吻合（差 ${diff}s）`)
  }

  let albumScore = 0
  if (request.album && candidate.albumName) {
    if (normalizeText(request.album) === normalizeText(candidate.albumName)) {
      albumScore = 1
      reasons.push(`专辑吻合（${candidate.albumName}）`)
    }
  }

  const wantedVariant = request.variant
  let variantScore: number
  if (wantedVariant) {
    variantScore = variant === wantedVariant ? 2 : 0
    if (variant !== wantedVariant) reasons.push(`版本不符（要 ${wantedVariant}，实际 ${variant}）`)
  } else {
    variantScore = VARIANT_PRIORITY[variant]
    reasons.push(`版本：${variant}`)
  }

  return { ok: true, score: variantScore * 2 + durationScore + albumScore, variant, reasons }
}

/**
 * 从一组候选里挑最佳匹配（Tier-2 用）。返回 `undefined` 表示"没有合格候选"——
 * **绝不退化成"取第 0 个"**。
 */
export function pickBestMatch(
  request: MatchRequest,
  candidates: readonly MatchCandidate[],
  options: { durationToleranceSec?: number } = {},
): { candidate: MatchCandidate; outcome: MatchOutcome } | undefined {
  let best: { candidate: MatchCandidate; outcome: MatchOutcome } | undefined
  for (const candidate of candidates) {
    const outcome = strictMatch(request, candidate, options)
    if (!outcome.ok) continue
    if (!best || outcome.score > best.outcome.score) best = { candidate, outcome }
  }
  return best
}
