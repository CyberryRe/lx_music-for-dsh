// 移植自 lxserver musicSdk/wy/lyric.js（Apache-2.0）：wy（网易云）歌词获取。
// 接口实测：interface3.music.163.com 的 eapi 通道需要「原始路径」作为加密 path
// （老实现用完整 URL，现在返回 {"code":404,"接口未找到！"}），
// 这里改为 eapi('/api/song/lyric/v1', {...}) 打 https://interface3.music.163.com/eapi/song/lyric/v1，
// 实测 HTTP 200 且 body 直接就是明文 JSON（无需 eapiDecrypt）。
//
// 公开接口：getLyric(info) → Promise<LyricPayload>，info.songmid = 网易数字 id。
import { httpFetch } from '../request'
import { eapi } from './utils/crypto'

/** 请求超时。 */
const TIMEOUT_MS = 10_000
/** 单平台内部重试上限。 */
const MAX_RETRY = 2

const createEapiRequest = (url, data) => {
  return httpFetch('https://interface3.music.163.com/eapi/song/lyric/v1', {
    method: 'post',
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/60.0.3112.90 Safari/537.36',
      origin: 'https://music.163.com',
    },
    form: eapi(url, data),
    timeout: TIMEOUT_MS,
  })
}

const parseTools = {
  rxps: {
    info: /^{"/,
    lineTime: /^\[(\d+),\d+\]/,
    wordTime: /\(\d+,\d+,\d+\)/,
    wordTimeAll: /(\(\d+,\d+,\d+\))/g,
  },
  msFormat(timeMs) {
    if (Number.isNaN(timeMs)) return ''
    let ms = timeMs % 1000
    timeMs /= 1000
    const m = parseInt(timeMs / 60).toString().padStart(2, '0')
    timeMs %= 60
    const s = parseInt(timeMs).toString().padStart(2, '0')
    return `[${m}:${s}.${ms}]`
  },
  parseLyric(lines) {
    const lxlrcLines = []
    const lrcLines = []

    for (let line of lines) {
      line = line.trim()
      const result = this.rxps.lineTime.exec(line)
      if (!result) {
        if (line.startsWith('[offset')) {
          lxlrcLines.push(line)
          lrcLines.push(line)
        }
        continue
      }

      const startMsTime = parseInt(result[1])
      const startTimeStr = this.msFormat(startMsTime)
      if (!startTimeStr) continue

      const words = line.replace(this.rxps.lineTime, '')

      lrcLines.push(`${startTimeStr}${words.replace(this.rxps.wordTimeAll, '')}`)

      let times = words.match(this.rxps.wordTimeAll)
      if (!times) continue
      times = times.map(time => {
        const result = /\((\d+),(\d+),\d+\)/.exec(time)
        return `<${Math.max(parseInt(result[1]) - startMsTime, 0)},${result[2]}>`
      })
      const wordArr = words.split(this.rxps.wordTime)
      wordArr.shift()
      const newWords = times.map((time, index) => `${time}${wordArr[index]}`).join('')
      lxlrcLines.push(`${startTimeStr}${newWords}`)
    }
    return {
      lyric: lrcLines.join('\n'),
      lxlyric: lxlrcLines.join('\n'),
    }
  },
  parseHeaderInfo(str) {
    str = str.trim()
    str = str.replace(/\r/g, '')
    if (!str) return null
    const lines = str.split('\n')
    return lines.map(line => {
      if (!this.rxps.info.test(line)) return line
      try {
        const info = JSON.parse(line)
        const timeTag = this.msFormat(info.t)
        return timeTag ? `${timeTag}${info.c.map(t => t.tx).join('')}` : ''
      } catch {
        return ''
      }
    })
  },
  getIntv(interval) {
    if (!interval) return 0
    if (!interval.includes('.')) interval += '.0'
    const arr = interval.split(/:|\./)
    while (arr.length < 3) arr.unshift('0')
    const [m, s, ms] = arr
    return parseInt(m) * 3600000 + parseInt(s) * 1000 + parseInt(ms)
  },
  fixTimeTag(lrc, targetlrc) {
    let lrcLines = lrc.split('\n')
    const targetlrcLines = targetlrc.split('\n')
    const timeRxp = /^\[([\d:.]+)\]/
    let temp = []
    const newLrc = []
    targetlrcLines.forEach((line) => {
      const result = timeRxp.exec(line)
      if (!result) return
      const words = line.replace(timeRxp, '')
      if (!words.trim()) return
      const t1 = this.getIntv(result[1])

      while (lrcLines.length) {
        const lrcLine = lrcLines.shift()
        const lrcLineResult = timeRxp.exec(lrcLine)
        if (!lrcLineResult) continue
        const t2 = this.getIntv(lrcLineResult[1])
        if (Math.abs(t1 - t2) < 100) {
          const lrc = line.replace(timeRxp, lrcLineResult[0]).trim()
          if (!lrc) continue
          newLrc.push(lrc)
          break
        }
        temp.push(lrcLine)
      }
      lrcLines = [...temp, ...lrcLines]
      temp = []
    })
    return newLrc.join('\n')
  },
  parse(ylrc, ytlrc, yrlrc, lrc, tlrc, rlrc) {
    const info = {
      lyric: '',
      tlyric: '',
      rlyric: '',
      lxlyric: '',
    }
    if (ylrc) {
      const lines = this.parseHeaderInfo(ylrc)
      if (lines) {
        const result = this.parseLyric(lines)
        if (ytlrc) {
          const tlines = this.parseHeaderInfo(ytlrc)
          if (tlines) info.tlyric = this.fixTimeTag(result.lyric, tlines.join('\n'))
        }
        if (yrlrc) {
          const rlines = this.parseHeaderInfo(yrlrc)
          if (rlines) info.rlyric = this.fixTimeTag(result.lyric, rlines.join('\n'))
        }

        const timeRxp = /^\[[\d:.]+\]/
        const headers = lines.filter(l => timeRxp.test(l)).join('\n')
        info.lyric = `${headers}\n${result.lyric}`
        info.lxlyric = result.lxlyric
        return info
      }
    }
    if (lrc) {
      const lines = this.parseHeaderInfo(lrc)
      if (lines) info.lyric = lines.join('\n')
    }
    if (tlrc) {
      const lines = this.parseHeaderInfo(tlrc)
      if (lines) info.tlyric = lines.join('\n')
    }
    if (rlrc) {
      const lines = this.parseHeaderInfo(rlrc)
      if (lines) info.rlyric = lines.join('\n')
    }

    return info
  },
}

// https://github.com/lyswhut/lx-music-mobile/issues/370
const fixTimeLabel = (lrc, tlrc, romalrc) => {
  if (lrc) {
    const newLrc = lrc.replace(/\[(\d{2}:\d{2}):(\d{2})]/g, '[$1.$2]')
    const newTlrc = tlrc?.replace(/\[(\d{2}:\d{2}):(\d{2})]/g, '[$1.$2]') ?? tlrc
    if (newLrc != lrc || newTlrc != tlrc) {
      lrc = newLrc
      tlrc = newTlrc
      if (romalrc) romalrc = romalrc.replace(/\[(\d{2}:\d{2}):(\d{2,3})]/g, '[$1.$2]').replace(/\[(\d{2}:\d{2}\.\d{2})0]/g, '[$1]')
    }
  }

  return { lrc, tlrc, romalrc }
}

/** 带时间标签校验：网易偶尔只回标签行（无时间行），这种视为失败。 */
const hasTimeLine = (lrc) => /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(lrc)

/**
 * 无版权/无歌词时网易会回一条占位歌词（如 `[00:00.00]暂无歌词`），
 * 它带时间标签但不是歌词 —— 去掉时间标签与空白后过短就判为失败。
 */
const PLACEHOLDER_MAX = 12
const isPlaceholderLyric = (lrc) => {
  const text = String(lrc).replace(/\[[^\]]*\]/g, '').replace(/\s+/g, '')
  return text.length <= PLACEHOLDER_MAX
}

const requestLyric = async (songmid) => {
  const requestObj = createEapiRequest('/api/song/lyric/v1', {
    id: songmid,
    cp: false,
    tv: -1,
    lv: -1,
    rv: -1,
    kv: -1,
    yv: -1,
    ytv: -1,
    yrv: -1,
  })
  const { statusCode, body } = await requestObj.promise
  if (statusCode !== 200) throw new Error(`网易歌词请求失败（HTTP ${statusCode}）`)
  if (!body || typeof body !== 'object') throw new Error('网易歌词获取失败')
  if (body.code !== 200 || !body?.lrc?.lyric) throw new Error(`网易歌词获取失败${body?.code ? `（code=${body.code}）` : ''}`)

  const fix = fixTimeLabel(body.lrc.lyric, body.tlyric?.lyric, body.romalrc?.lyric)
  const info = parseTools.parse(body.yrc?.lyric, body.ytlrc?.lyric, body.yromalrc?.lyric, fix.lrc, fix.tlrc, fix.romalrc)
  if (!info.lyric || !hasTimeLine(info.lyric) || isPlaceholderLyric(info.lyric)) throw new Error('网易歌词获取失败')
  return {
    lyric: info.lyric,
    tlyric: info.tlyric || '',
    rlyric: info.rlyric || '',
    lxlyric: info.lxlyric || '',
    format: 'lrc',
  }
}

export default {
  /**
   * @param {{ songmid: string | number }} info
   * @returns {Promise<{ lyric: string, tlyric: string, rlyric: string, lxlyric: string, format: string }>}
   */
  async getLyric(info) {
    const songmid = Number(info?.songmid)
    if (!Number.isFinite(songmid) || songmid <= 0) throw new Error('网易歌词获取失败：缺少有效的 songmid')

    let lastErr
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        return await requestLyric(songmid)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('网易歌词获取失败')
  },
}
