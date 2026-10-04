// 移植自 lxserver musicSdk/tx/lyric.js（Apache-2.0）：tx（QQ音乐）歌词获取。
// 接口 c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg，必须带
// Referer: https://y.qq.com/portal/player.html，否则返回 403/空。
// 响应 { lyric: base64, trans: base64 }，内容里带 HTML 实体，需要解码。
//
// 公开接口：getLyric(info) → Promise<LyricPayload>，info.songmid = QQ songmid（字母数字）。
import { httpFetch } from '../request'

/** 请求超时。 */
const TIMEOUT_MS = 10_000
/** 单平台内部重试上限。 */
const MAX_RETRY = 2

/** 与原实现在 tx/lyric.js 里的局部 decodeName 完全一致（含 &#(\d+); 十进制实体）。 */
const decodeName = (str = '') => {
  if (!str) return ''
  return str.replace(/&#(\d+);/g, (match, dec) => {
    return String.fromCharCode(dec)
  }).replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

const b64DecodeUnicode = (str) => Buffer.from(str, 'base64').toString('utf8')

const hasTimeLine = (lrc) => /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(lrc)

const requestLyric = async (songId) => {
  const url = `https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid=${songId}&g_tk=5381&loginUin=0&hostUin=0&format=json&inCharset=utf8&outCharset=utf-8&platform=yqq`
  const { body, statusCode } = await httpFetch(url, {
    headers: {
      Referer: 'https://y.qq.com/portal/player.html',
    },
    timeout: TIMEOUT_MS,
  }).promise

  if (statusCode !== 200) throw new Error(`QQ音乐歌词请求失败（HTTP ${statusCode}）`)
  if (!body || typeof body !== 'object') throw new Error('QQ音乐歌词获取失败')
  if (body.code != 0 || !body.lyric) throw new Error(`QQ音乐歌词获取失败${body.code != null ? `（code=${body.code}）` : ''}`)

  const lyric = decodeName(b64DecodeUnicode(body.lyric))
  if (!hasTimeLine(lyric)) throw new Error('QQ音乐歌词获取失败')
  const tlyric = body.trans ? decodeName(b64DecodeUnicode(body.trans)) : ''

  return {
    lyric,
    tlyric: tlyric || '',
    rlyric: '',
    lxlyric: '',
    format: 'lrc',
  }
}

export default {
  /**
   * @param {{ songmid: string | number }} info
   * @returns {Promise<{ lyric: string, tlyric: string, rlyric: string, lxlyric: string, format: string }>}
   */
  async getLyric(info) {
    const songId = info?.songmid
    if (songId == null || String(songId).trim() === '') throw new Error('QQ音乐歌词获取失败：缺少有效的 songmid')

    let lastErr
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        return await requestLyric(songId)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('QQ音乐歌词获取失败')
  },
}
