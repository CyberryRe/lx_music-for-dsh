// 内置 SDK 歌词门面（host 侧，Node）：五个平台的歌词抓取。
//
// 与搜索一样：`src/sdk/<平台>/lyric.js` 是原样移植的第三方代码，本文件只做
//   MusicInfo → SdkLyricSongInfo 的取值、平台分发、结果形状收敛。
// 解析（LRC → 结构化的行/逐字轴）在 `src/shared/lrc.ts`，本文件不碰文本格式。

import type { MusicInfo, LyricSource, MusicSource } from '../shared/types'
import type { RawLyricPayload } from '../shared/lrc'
import type { SdkLyricModule, SdkLyricSongInfo } from './lyricTypes.d'
import kwLyric from './kw/lyric.js'
import wyLyric from './wy/lyric.js'
import kgLyric from './kg/lyric.js'
import txLyric from './tx/lyric.js'
import mgLyric from './mg/lyric.js'

export type { SdkLyricSongInfo, SdkLyricPayload, SdkLyricModule } from './lyricTypes.d'

/** 一次成功的歌词抓取：原始文本 + 来源渠道与格式标记（供 LyricsDoc 诊断）。 */
export interface LyricFetch {
  payload: RawLyricPayload
  source: LyricSource
  format: string
}

const MODULES: Partial<Record<MusicSource, SdkLyricModule>> = {
  kw: kwLyric as unknown as SdkLyricModule,
  wy: wyLyric as unknown as SdkLyricModule,
  kg: kgLyric as unknown as SdkLyricModule,
  tx: txLyric as unknown as SdkLyricModule,
  mg: mgLyric as unknown as SdkLyricModule,
}

/**
 * MusicInfo → 各平台歌词模块的入参。
 *
 * 关键点：各平台要的 id 字段名不同（kw/wy/tx 用 `songmid`、kg 还要 `hash` 与 `interval`、
 * mg 直接吃搜索下发的 `lrcUrl/mrcUrl/trcUrl`），这里统一从 `music.meta` 提升。
 */
export function buildLyricSongInfo(music: MusicInfo): SdkLyricSongInfo {
  const meta = music.meta ?? ({} as MusicInfo['meta'])
  const info: SdkLyricSongInfo = { name: music.name }
  if (music.singer) info.singer = music.singer
  if (music.interval) info.interval = music.interval
  if (meta.songId !== undefined && meta.songId !== null && meta.songId !== '') info.songmid = meta.songId
  if (meta.hash) info.hash = meta.hash
  if (meta.copyrightId) info.copyrightId = meta.copyrightId
  if (meta.lrcUrl) info.lrcUrl = meta.lrcUrl
  if (meta.mrcUrl) info.mrcUrl = meta.mrcUrl
  if (meta.trcUrl) info.trcUrl = meta.trcUrl
  return info
}

/** 结果形状校验：必须至少有一份可用文本，否则视为失败（宁可抛错也不要空歌词）。 */
function normalizePayload(raw: unknown): RawLyricPayload | null {
  if (typeof raw === 'string') {
    const text = raw.trim()
    return text ? { lyric: text } : null
  }
  if (!raw || typeof raw !== 'object') return null
  const obj = raw as Record<string, unknown>
  const pick = (key: string): string | undefined => (typeof obj[key] === 'string' ? (obj[key] as string) : undefined)
  const payload: RawLyricPayload = {
    lyric: pick('lyric') ?? '',
    ...(pick('tlyric') ? { tlyric: pick('tlyric')! } : {}),
    ...(pick('rlyric') ? { rlyric: pick('rlyric')! } : {}),
    ...(pick('lxlyric') ? { lxlyric: pick('lxlyric')! } : {}),
    ...(pick('format') ? { format: pick('format')! } : {}),
  }
  if ((payload.lyric ?? '').trim() === '' && (payload.lxlyric ?? '').trim() === '') return null
  return payload
}

/** 音源脚本 `lyric` action 的返回值 → 统一 payload（脚本可能返回字符串或对象）。 */
export function scriptLyricToPayload(raw: unknown): RawLyricPayload | null {
  return normalizePayload(raw)
}

/**
 * 用内置 SDK 抓取指定平台的歌词。
 *
 * 失败一律抛出可读错误：`未找到 X 的歌词` / 平台原始错误信息。调用方（EngineProvider）
 * 负责决定是否继续降级或向用户报告。
 */
export async function fetchPlatformLyric(music: MusicInfo, options: { format?: string } = {}): Promise<LyricFetch> {
  const mod = MODULES[music.source]
  if (!mod) throw new Error(`内置 SDK 暂不支持 ${music.source} 平台的歌词`)
  const raw = await mod.getLyric(buildLyricSongInfo(music))
  const payload = normalizePayload(raw)
  if (!payload) throw new Error(`${music.source} 平台没有返回可用的歌词`)
  const auto = payload.lxlyric ? 'lxlyric' : 'lrc'
  return {
    payload,
    source: 'sdk',
    format: options.format ?? payload.format ?? auto,
  }
}
