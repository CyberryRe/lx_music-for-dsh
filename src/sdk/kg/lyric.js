// 移植自 lxserver musicSdk/kg/lyric.js + common/utils/lyricUtils/kg.js（Apache-2.0）：
// kg（酷狗）歌词获取。两处 helper（decodeKrc / parseLyric）内联在本文件，
// 只用 node:zlib，无外部依赖。
//
// 公开接口：getLyric(info) → Promise<LyricPayload>。
// 需要 info.name（搜索关键字）与 info.hash（FileHash）；time 优先用 info._interval（毫秒），
// 没有则把 info.interval（"mm:ss"）换算成毫秒。
import { inflate } from 'node:zlib'
import { httpFetch } from '../request'
import { decodeName } from '../utils'

/** 请求超时。 */
const TIMEOUT_MS = 10_000
/** 单平台内部重试上限。 */
const MAX_RETRY = 2

const KG_HEADERS = {
  'KG-RC': 1,
  'KG-THash': 'expand_search_manager.cpp:852736169:451',
  'User-Agent': 'KuGou2012-9020-ExpandSearchManager',
}

// ---------------------------------------------------------------------------
// decodeKrc（原 common/utils/lyricUtils/kg.js）
// ---------------------------------------------------------------------------

// https://github.com/lyswhut/lx-music-desktop/issues/296#issuecomment-683285784
const encKey = Buffer.from([0x40, 0x47, 0x61, 0x77, 0x5e, 0x32, 0x74, 0x47, 0x51, 0x36, 0x31, 0x2d, 0xce, 0xd2, 0x6e, 0x69], 'binary')

const decodeKrcData = str => new Promise((resolve, reject) => {
  // ⚠️ 空内容必须 reject：`return`（不 settle）会让 await 永远挂住，
  // 表现是歌词窗口一直"正在获取歌词…"，而且失败不进缓存 → 重开还是挂。
  if (!str || !str.length) return reject(new Error('酷狗歌词内容为空'))
  const bufStr = Buffer.from(str, 'base64').subarray(4)
  for (let i = 0, len = bufStr.length; i < len; i++) {
    bufStr[i] = bufStr[i] ^ encKey[i % 16]
  }
  inflate(bufStr, (err, result) => {
    if (err) return reject(err)
    resolve(result.toString())
  })
})

const headExp = /^.*\[id:\$\w+\]\n/

const parseKrcLyric = str => {
  str = str.replace(/\r/g, '')
  if (headExp.test(str)) str = str.replace(headExp, '')
  const trans = str.match(/\[language:([\w=\\/+]+)\]/)
  let rlyric
  let tlyric
  if (trans) {
    str = str.replace(/\[language:[\w=\\/+]+\]\n/, '')
    const json = JSON.parse(Buffer.from(trans[1], 'base64').toString())
    for (const item of json.content) {
      switch (item.type) {
        case 0:
          rlyric = item.lyricContent
          break
        case 1:
          tlyric = item.lyricContent
          break
      }
    }
  }
  let i = 0
  let lxlyric = str.replace(/\[((\d+),\d+)\].*/g, str => {
    const result = str.match(/\[((\d+),\d+)\].*/)
    let time = parseInt(result[2])
    const ms = time % 1000
    time /= 1000
    const m = parseInt(time / 60).toString().padStart(2, '0')
    time %= 60
    const s = parseInt(time).toString().padStart(2, '0')
    time = `${m}:${s}.${ms}`
    if (rlyric) rlyric[i] = `[${time}]${rlyric[i]?.join('') ?? ''}`
    if (tlyric) tlyric[i] = `[${time}]${tlyric[i]?.join('') ?? ''}`
    i++
    return str.replace(result[1], time)
  })
  rlyric = rlyric ? rlyric.join('\n') : ''
  tlyric = tlyric ? tlyric.join('\n') : ''
  lxlyric = lxlyric.replace(/<(\d+,\d+),\d+>/g, '<$1>')
  lxlyric = decodeName(lxlyric)
  const lyric = lxlyric.replace(/<\d+,\d+>/g, '')
  rlyric = decodeName(rlyric)
  tlyric = decodeName(tlyric)
  return { lyric, tlyric, rlyric, lxlyric }
}

const decodeKrc = async (data) => decodeKrcData(data).then(parseKrcLyric)

// ---------------------------------------------------------------------------
// lyric（原 kg/lyric.js）
// ---------------------------------------------------------------------------

/** "mm:ss" / "hh:mm:ss" → 秒。 */
const getIntv = (interval) => {
  if (!interval) return 0
  const intvArr = String(interval).split(':')
  let intv = 0
  let unit = 1
  while (intvArr.length) {
    intv += (intvArr.pop()) * unit
    unit *= 60
  }
  return parseInt(intv)
}

/**
 * 曲目时长，**统一返回毫秒**。
 *
 * 为什么必须统一：酷狗 `/search` 返回的 `candidates[].duration` 是毫秒（实测 269792 这种），
 * 而 `interval`（"04:29"）经 `getIntv` 得到的是**秒**。早期把秒直接和毫秒比，评分退化成
 * "永远挑最短的候选"，于是有片段/Live/Remix 候选时会拿到**别的版本**的歌词。
 * `timelength` 查询参数也用这个值（同一单位，避免 1000 倍偏差）。
 */
const getTimeLengthMs = (info) => {
  if (info && info._interval != null && Number(info._interval) > 0) return Math.round(Number(info._interval))
  return getIntv(info?.interval) * 1000
}

/**
 * 酷狗歌词搜索是关键字匹配：candidates 里**没有** FileHash 字段（实测），
 * 传进去的 hash 只影响 keyword 归一化（命中时会被纠正成「歌手 - 歌名」），
 * 不会做精确过滤。所以这里按「官方推荐歌词优先，其次时长最接近」打分，
 * 命中不了再退回第一个候选 —— 宁可给一个同曲近似版本，也不要空手而归。
 *
 * `timeMs` 必须是**毫秒**（与 `item.duration` 同单位）。
 */
const pickCandidate = (candidates, timeMs) => {
  let best = null
  for (const item of candidates) {
    const official = item.krctype == 1 && item.contenttype != 1
    const d = Number(item.duration)
    const diff = timeMs > 0 && Number.isFinite(d) && d > 0 ? Math.abs(d - timeMs) : Number.POSITIVE_INFINITY
    const score = [official ? 0 : 1, diff]
    if (best == null || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
      best = { item, score }
    }
  }
  return best ? best.item : candidates[0]
}

const searchLyric = (name, hash, timeMs) => {
  const url = `https://lyrics.kugou.com/search?ver=1&man=yes&client=pc&keyword=${encodeURIComponent(name)}&hash=${hash}&timelength=${timeMs}&lrctxt=1`
  return httpFetch(url, { headers: KG_HEADERS, timeout: TIMEOUT_MS }).promise.then(({ body, statusCode }) => {
    if (statusCode !== 200) throw new Error(`酷狗歌词搜索失败（HTTP ${statusCode}）`)
    const candidates = body?.candidates
    if (!candidates || !candidates.length) return null
    const info = pickCandidate(candidates, timeMs)
    return {
      id: info.id,
      accessKey: info.accesskey,
      fmt: (info.krctype == 1 && info.contenttype != 1) ? 'krc' : 'lrc',
    }
  })
}

const downloadLyric = (id, accessKey, fmt) => {
  const url = `https://lyrics.kugou.com/download?ver=1&client=pc&id=${id}&accesskey=${accessKey}&fmt=${fmt}&charset=utf8`
  return httpFetch(url, { headers: KG_HEADERS, timeout: TIMEOUT_MS }).promise.then(({ body, statusCode }) => {
    if (statusCode !== 200) throw new Error(`酷狗歌词下载失败（HTTP ${statusCode}）`)
    switch (body?.fmt) {
      case 'krc':
        return decodeKrc(body.content)
      case 'lrc':
        return {
          lyric: Buffer.from(body.content, 'base64').toString('utf-8'),
          tlyric: '',
          rlyric: '',
          lxlyric: '',
        }
      default:
        throw new Error(`酷狗歌词格式不支持：${body?.fmt}`)
    }
  })
}

const hasTimeLine = (lrc) => /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(lrc)

const requestLyric = async (info) => {
  // hash 允许缺失：酷狗的歌词搜索本身就是关键字匹配（实测 hash 只用于纠正关键字，
  // 不做精确过滤），没有 FileHash 的歌也照样能搜到歌词。
  const found = await searchLyric(info.name, info.hash ?? '', getTimeLengthMs(info))
  if (!found) throw new Error('酷狗歌词获取失败：未找到歌词')
  const payload = await downloadLyric(found.id, found.accessKey, found.fmt)
  if (!payload?.lyric || !hasTimeLine(payload.lyric)) throw new Error('酷狗歌词获取失败：歌词为空')
  return {
    lyric: payload.lyric,
    tlyric: payload.tlyric || '',
    rlyric: payload.rlyric || '',
    lxlyric: payload.lxlyric || '',
    format: 'lrc',
  }
}

export default {
  /**
   * @param {{ name: string, hash?: string, interval?: string | null, _interval?: number }} info
   * @returns {Promise<{ lyric: string, tlyric: string, rlyric: string, lxlyric: string, format: string }>}
   */
  async getLyric(info) {
    if (!info?.name) throw new Error('酷狗歌词获取失败：缺少歌曲名')
    if (!info?.hash) throw new Error('酷狗歌词获取失败：缺少 hash')

    let lastErr
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        return await requestLyric(info)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('酷狗歌词获取失败')
  },
}
