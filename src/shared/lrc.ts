// LRC / 逐字 LRC 解析（纯函数，host 与 client 共用）。
//
// 定位：host 抓到歌词原文后**只在这里解析一次**，把结构化的 `LyricDoc` 通过 remote 发给 client；
// client 侧不再做正则解析，只做"当前行/当前字"的查表与渲染。这样：
//   - 解析逻辑可单测（tests/lrc.test.ts），不依赖 DOM 与网络；
//   - 两端对同一份歌词的理解不会分叉。
//
// 规则移植并强化自 lx-music-desktop（Apache-2.0）：
//   - `src/utils/lrcTool.ts`（时间标签归一化、翻译行时间对齐）
//   - `src/common/utils/lyric-font-player/line-player.js`（行解析、重复时间戳、offset 标签）
// 与上游的差异（刻意的）：
//   - 逐字时间轴解析成 `<起点ms,时长ms>` 结构而不是拼字符串，UI 可直接做卡拉OK高亮；
//   - 翻译/音译按"最近时间"匹配（±300ms），因为各平台给出的翻译时间标签常有几十毫秒偏差；
//   - 没有时间标签的纯文本歌词会补出**等间隔**伪时间轴（有真实时长时用它，否则 3 秒/行）。

import type { LyricDoc, LyricLine, LyricSource, LyricWord, MusicSource } from './types'

/** 行首时间标签：`[mm:ss.xxx]`、`[hh:mm:ss]`，允许一行多个（`[00:01.00][00:05.00]词`）。 */
const TIME_FIELD = /^(?:\[[\d:.]+\])+/
/** 从时间标签串里逐个取出时间值。 */
const TIME_VALUE = /\d{1,3}(?::\d{1,3}){0,2}(?:\.\d{1,3})?/g
/** 逐字时间标签：`<起点,时长>` / `<起点,时长,保留>`（毫秒，相对行首）。 */
const WORD_TAG = /<(-?\d+),(-?\d+)(?:,-?\d+)?>/g

/** 翻译/音译行与主歌词行的时间匹配容差（毫秒）。 */
const TRANSLATION_TOLERANCE_MS = 300
/** 纯文本歌词补伪时间轴时的默认行间隔（秒）。 */
const PLAIN_STEP_SECONDS = 3
/** 末行的兜底持续时长（秒）。 */
const LAST_LINE_FALLBACK_SECONDS = 5
/** 行/字的合理时长上限（秒/毫秒）：超出说明时间标签是脏数据，截断避免 UI 卡在高亮上。 */
const MAX_LINE_SECONDS = 30

/** 歌词原文（各来源统一形状）。 */
export interface RawLyricPayload {
  /** 标准 LRC。 */
  lyric?: string
  /** 翻译。 */
  tlyric?: string
  /** 音译。 */
  rlyric?: string
  /** 逐字 LRC（`[mm:ss.xxx]<起点,时长>字…`）。 */
  lxlyric?: string
  /** 平台实际返回的格式标记（诊断用）：lrc / lxlyric / krc / mrc / script。 */
  format?: string
}

export interface ParseLyricOptions {
  source: LyricSource
  /** 命中的平台（写进 doc.platform）。 */
  platform?: MusicSource
  /** 平台格式标记；缺省按 `lrc`。 */
  format?: string
  /** 已知曲目时长（秒）：用于末行 duration 与纯文本伪时间轴间隔。 */
  duration?: number
  /** 纯文本歌词是否补伪时间轴（默认 true）。 */
  allowPlain?: boolean
  /** `[offset:]` 缺省值（毫秒）；平台若在 payload 外单独给了偏移可用它。 */
  offsetMs?: number
}

interface TimedText {
  time: number
  text: string
  /** 只有这些行被当作"歌词行"；空文本行不产生行（但保留时间轴用于计算时长）。 */
  words?: LyricWord[]
  /** 同时间戳合并进来的翻译/音译。 */
  tr?: string
  ro?: string
}

/**
 * 解析 `[hh:mm:ss.xxx]` / `[mm:ss.xxx]` / `[mm:ss]` / `[ss]` → 秒。
 * 段数决定语义（与 lx 一致）：1 段 = 秒、2 段 = 分:秒、3 段 = 时:分:秒。
 * 返回 `null` 表示无法解析（脏标签，整行丢弃）。
 */
export function parseLrcTimeLabel(label: string): number | null {
  const parts = label.split(':')
  if (parts.length === 0 || parts.length > 3) return null
  const nums = parts.map((p) => (p.trim() === '' ? Number.NaN : Number(p)))
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null
  if (nums.length === 1) return nums[0]!
  if (nums.length === 2) return nums[0]! * 60 + nums[1]!
  return nums[0]! * 3600 + nums[1]! * 60 + nums[2]!
}

/** 秒 → 毫秒整数键（对齐翻译行/逐字行用）。 */
function msKey(seconds: number): number {
  return Math.round(seconds * 1000)
}

/** 把逐字标签从文本里剥离，返回纯文本 + 词片段。 */
function splitWords(rawText: string): { text: string; words?: LyricWord[] } {
  const re = new RegExp(WORD_TAG.source, 'g')
  if (!re.test(rawText)) return { text: rawText }
  // 逐个 `<a,b>` 取词：标签后面的文字属于该词。
  const words: LyricWord[] = []
  let text = ''
  let cursor = 0
  const re2 = new RegExp(WORD_TAG.source, 'g')
  let m: RegExpExecArray | null
  let pending: { time: number; duration: number } | null = null
  while ((m = re2.exec(rawText)) !== null) {
    // 标签之前的文字：若已有一个待归属的词，则它是那个词的文字
    const between = rawText.slice(cursor, m.index)
    if (between) {
      if (pending) words.push({ ...pending, text: between })
      else text += between
    }
    cursor = m.index + m[0].length
    const start = Number(m[1])
    const dur = Number(m[2])
    pending = {
      time: Number.isFinite(start) ? Math.max(0, Math.trunc(start)) : 0,
      duration: Number.isFinite(dur) ? Math.max(0, Math.trunc(dur)) : 0,
    }
  }
  const tail = rawText.slice(cursor)
  if (tail) {
    if (pending) words.push({ ...pending, text: tail })
    else text += tail
  }
  // 词尾如果没落到文本上（极少见），丢弃空词避免 UI 出现空 span
  const kept = words.filter((w) => w.text !== '')
  const plainText = `${text}${kept.map((w) => w.text).join('')}`.trim()
  return kept.length > 0
    ? { text: plainText, words: kept }
    : { text: rawText.replace(new RegExp(WORD_TAG.source, 'g'), '').trim() }
}

/** 提取一行的时间标签（可多个）与正文。 */
function parseTimedLine(line: string): { times: number[]; text: string } | null {
  const field = new RegExp(TIME_FIELD.source).exec(line)
  if (!field) return null
  const times: number[] = []
  const values = field[0].match(new RegExp(TIME_VALUE.source, 'g')) ?? []
  for (const v of values) {
    const t = parseLrcTimeLabel(v)
    if (t !== null) times.push(t)
  }
  if (times.length === 0) return null
  return { times, text: line.slice(field[0].length).trim() }
}

/** 逐字 LRC → `msKey → 词片段`。 */
function parseWordTimeline(lxlyric: string): Map<number, LyricWord[]> {
  const map = new Map<number, LyricWord[]>()
  for (const raw of lxlyric.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line) continue
    const parsed = parseTimedLine(line)
    if (!parsed) continue
    const split = splitWords(parsed.text)
    if (!split.words || split.words.length === 0) continue
    for (const t of parsed.times) map.set(msKey(t), split.words)
  }
  return map
}

/** LRC 文本 → 带时间的行（保留重复时间戳，交给后面的翻译合并处理）。 */
function parseTimedLines(text: string): TimedText[] {
  const out: TimedText[] = []
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line) continue
    const parsed = parseTimedLine(line)
    if (!parsed) continue
    const split = splitWords(parsed.text)
    for (const t of parsed.times) out.push({ time: t, text: split.text, ...(split.words ? { words: split.words } : {}) })
  }
  return out
}

/** 从 `[offset:…]` 里取偏移（毫秒）。 */
function readOffsetMs(lyric: string): number | null {
  const m = /\[offset:\s*([+-]?\d+)\s*\]/i.exec(lyric)
  if (!m) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/** 翻译行匹配：按时间就近（±容差），双向指针；**一行翻译只归属一行歌词**。 */
function attachExtras(lines: LyricLine[], timing: TimedText[], field: 'tr' | 'ro', tolerance = TRANSLATION_TOLERANCE_MS): void {
  if (timing.length === 0 || lines.length === 0) return
  const sorted = [...timing].sort((a, b) => a.time - b.time)
  let j = 0
  for (const line of lines) {
    const target = msKey(line.time)
    while (j < sorted.length && msKey(sorted[j]!.time) < target - tolerance) j++
    const candidate = sorted[j]
    if (!candidate) break
    if (Math.abs(msKey(candidate.time) - target) <= tolerance && candidate.text) {
      if (field === 'tr') line.tr = candidate.text
      else line.ro = candidate.text
      // 消费掉这一行：容差窗口是闭区间，两行歌词相隔 <300ms 时（间奏/气声很常见）
      // 不前进就会把同一句翻译贴到两行上。
      j++
    }
  }
}

/**
 * 时间戳完全相同的行：后一行是前一行的翻译（酷我/网易的歌词里翻译与原文共用时间戳）。
 * 只在**没有独立 tlyric** 时启用，避免误把重复的副歌当翻译。
 */
function mergeDuplicateTimestamps(rows: TimedText[]): { rows: TimedText[]; merged: number } {
  const byKey = new Map<number, TimedText[]>()
  for (const row of rows) {
    const key = msKey(row.time)
    const list = byKey.get(key)
    if (list) list.push(row)
    else byKey.set(key, [row])
  }
  const out: TimedText[] = []
  let merged = 0
  for (const [, list] of byKey) {
    if (list.length === 1) {
      out.push(list[0]!)
      continue
    }
    // 第一行当主歌词，其余非空且不同的文本按顺序当翻译/音译
    const [first, ...rest] = list
    const extra = rest.filter((r) => r.text && r.text !== first!.text)
    out.push({ ...first!, ...(extra[0] ? { tr: extra[0].text } : {}) })
    merged += 1
  }
  return { rows: out, merged }
}

/** 纯文本歌词 → 等间隔伪时间轴（有真实时长就铺满，否则 3 秒/行）。 */
function synthesizePlain(text: string, duration?: number): TimedText[] {
  const texts = text
    .split(/\r\n|\r|\n/)
    .map((l) => l.trim())
    .filter((l) => l !== '')
  if (texts.length === 0) return []
  const step = duration && duration > 0
    ? Math.max(2, Math.min(6, duration / (texts.length + 1)))
    : PLAIN_STEP_SECONDS
  return texts.map((t, i) => ({ time: i * step, text: t }))
}

/**
 * 解析一份歌词。
 *
 * `lines` 永远按时间升序且**已应用 offset**；解析不出任何带时间的行时返回空 `lines`
 * （调用方据此显示 `note`，而不是抛错——"这首歌没歌词"不是异常）。
 */
export function parseLyric(payload: RawLyricPayload, options: ParseLyricOptions): LyricDoc {
  const source = options.source
  const format = options.format ?? 'lrc'
  const lyricText = (payload.lyric ?? '').trim()
  const tlText = (payload.tlyric ?? '').trim()
  const roText = (payload.rlyric ?? '').trim()
  const lxText = (payload.lxlyric ?? '').trim()

  const offsetMs = readOffsetMs(lyricText) ?? options.offsetMs ?? 0

  let rows = parseTimedLines(lyricText)
  let hasTranslation = tlText !== ''
  let plain = false

  // 主歌词没有时间轴时：先用逐字歌词兜底（有些来源只给 lxlyric），再考虑纯文本伪时间轴
  if (rows.length === 0 && lxText) {
    const wordMap = parseWordTimeline(lxText)
    rows = [...wordMap.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([ms, words]) => ({ time: ms / 1000, text: words.map((w) => w.text).join(''), words }))
  }
  if (rows.length === 0 && lyricText !== '' && (options.allowPlain ?? true)) {
    rows = synthesizePlain(lyricText, options.duration)
    plain = rows.length > 0
  }

  // 翻译/音译：优先用独立字段；没有独立翻译时，尝试同一时间戳的多行合并
  if (!hasTranslation && rows.length > 0) {
    const merged = mergeDuplicateTimestamps(rows)
    if (merged.merged > 0) {
      rows = merged.rows
      hasTranslation = rows.some((r) => r.tr !== undefined)
    }
  }

  // 应用 offset（正数 = 歌词提前）：displayTime = time - offset
  const shift = offsetMs / 1000

  const lines: LyricLine[] = rows.map((r) => ({
    time: Math.max(0, r.time - shift),
    text: r.text,
    ...(r.tr ? { tr: r.tr } : {}),
    ...(r.ro ? { ro: r.ro } : {}),
    ...(r.words ? { words: r.words } : {}),
    duration: 0,
  }))

  lines.sort((a, b) => a.time - b.time)

  // 附加翻译/音译（按原始时间匹配，再 shift）
  if (tlText) {
    const tl = parseTimedLines(tlText).map((r) => ({ ...r, time: Math.max(0, r.time - shift) }))
    attachExtras(lines, tl, 'tr')
  }
  if (roText) {
    const ro = parseTimedLines(roText).map((r) => ({ ...r, time: Math.max(0, r.time - shift) }))
    attachExtras(lines, ro, 'ro')
  }
  for (const line of lines) {
    if (line.tr === '') delete line.tr
    if (line.ro === '') delete line.ro
  }
  hasTranslation = hasTranslation || lines.some((l) => l.tr !== undefined)

  // 逐字时间轴：优先用 lxlyric（更权威）；否则用主歌词里内嵌的 <a,b>
  const wordMap = lxText ? parseWordTimeline(lxText) : new Map<number, LyricWord[]>()
  for (const line of lines) {
    if (line.words) continue
    const fromLx = wordMap.get(msKey(line.time + shift))
    if (fromLx) line.words = fromLx
  }
  // 剥离行内残留的逐字标签（有些来源的 lyric 与 lxlyric 混在一起）
  for (const line of lines) {
    if (line.text.includes('<')) line.text = line.text.replace(new RegExp(WORD_TAG.source, 'g'), '')
  }
  // 逐字时间轴为本行相对时间：先做合理性校验，再按行时长截断
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const next = lines[i + 1]
    const rt = next ? next.time - line.time : (options.duration && options.duration > line.time ? options.duration - line.time : LAST_LINE_FALLBACK_SECONDS)
    line.duration = Math.max(0.5, Math.min(MAX_LINE_SECONDS, rt))
    if (line.words) {
      if (!isValidWordTimeline(line.words, line.duration)) {
        // 脏数据：丢弃逐字轴，保留行文本（没有卡拉OK高亮好过把高亮打到别的字上）
        delete line.words
      } else {
        line.words = line.words.map((w) => ({
          ...w,
          time: Math.max(0, Math.min(w.time, Math.round(line.duration * 1000))),
          duration: w.duration > 0 ? Math.min(w.duration, Math.round(line.duration * 1000)) : 0,
        }))
        if (line.text === '') line.text = line.words.map((w) => w.text).join('')
      }
    }
  }

  const hasWordTiming = lines.some((l) => l.words !== undefined)
  const duration = lines.length > 0 ? (lines[lines.length - 1]!.time + lines[lines.length - 1]!.duration) : 0
  const doc: LyricDoc = {
    source,
    ...(options.platform ? { platform: options.platform } : {}),
    format: lines.length === 0 ? 'none' : format,
    lines,
    offset: offsetMs,
    hasTranslation,
    hasWordTiming,
    plain,
    duration,
  }
  if (lines.length === 0) doc.note = payload.lyric || payload.lxlyric ? '歌词没有可用的时间轴' : '未返回歌词内容'
  return doc
}

/**
 * 逐字时间轴合理性校验（单调不减、不越界）。
 *
 * 存在的理由：酷我的 `<a,b>` 逐字标签在上游实现里 scale 就是错的（`getWordInfo` 读的
 * `this.offset/offset2` 恒为 1），照抄会给出放大数倍的时间。任何"看起来不可能"的序列
 * 一律丢弃 words —— 宁可没有卡拉OK高亮，也不能让高亮跳到别的字上。
 */
function isValidWordTimeline(words: readonly LyricWord[], lineSeconds: number): boolean {
  if (words.length === 0) return false
  if (words.every((w) => w.time === 0 && w.duration === 0)) return false
  const limit = Math.round(lineSeconds * 1000) * 1.5 + 500
  let prev = -1
  for (const w of words) {
    if (!Number.isFinite(w.time) || w.time < 0) return false
    if (w.time > limit) return false
    if (w.time < prev) return false
    prev = w.time
  }
  return true
}

/**
 * 当前行下标：最后一个 `time <= seconds + leadIn` 的行。
 * `leadIn`（秒）让高亮稍微提前，贴近人耳"听到即看到"的体感。
 * 返回 -1 表示还没到第一行。
 */
export function findLyricLineIndex(lines: readonly LyricLine[], seconds: number, leadIn = 0.2): number {
  if (lines.length === 0) return -1
  const target = seconds + leadIn
  if (target < lines[0]!.time) return -1
  let lo = 0
  let hi = lines.length - 1
  let ans = 0
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid]!.time <= target) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * 当前行内的逐字下标：`words[i].time/1000 <= elapsed` 的最后一个（`elapsed` = 相对行首的秒数）。
 * 返回 -1 表示该行没有逐字或还没到第一个字。
 */
export function findLyricWordIndex(words: readonly LyricWord[] | undefined, elapsed: number): number {
  if (!words || words.length === 0) return -1
  const ms = elapsed * 1000
  let ans = -1
  for (let i = 0; i < words.length; i++) {
    if (words[i]!.time <= ms) ans = i
    else break
  }
  return ans
}
