// 移植自 lxserver musicSdk/mg/lyric.js + mg/utils/mrc.js（Apache-2.0）：mg（咪咕）歌词获取。
// TEA/BigInt 解密（decrypt）内联在本文件，只用 node: 内置能力（BigInt / Buffer）。
//
// 公开接口：getLyric(info) → Promise<LyricPayload>。
// 输入优先用搜索元数据里直接带的 mrcUrl / lrcUrl / trcUrl；
// 三者都缺时用 copyrightId 调 resourceinfo.do 回查一次。
import { httpFetch } from '../request'

/** 请求超时。 */
const TIMEOUT_MS = 10_000
/** 单平台内部重试上限。 */
const MAX_RETRY = 2

const MG_HEADERS = {
  Referer: 'https://app.c.nf.migu.cn/',
  'User-Agent': 'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/59.0.3071.115 Mobile Safari/537.36',
  channel: '0146921',
}

// ---------------------------------------------------------------------------
// mrc 解密（原 mg/utils/mrc.js，TEA + BigInt）
// ---------------------------------------------------------------------------

const DELTA = 2654435769n
const MIN_LENGTH = 32
const keyArr = [
  27303562373562475n,
  18014862372307051n,
  22799692160172081n,
  34058940340699235n,
  30962724186095721n,
  27303523720101991n,
  27303523720101998n,
  31244139033526382n,
  28992395054481524n,
]

// https://github.com/lyswhut/lx-music-desktop/issues/445#issuecomment-1139338682
const MAX = 9223372036854775807n
const MIN = -9223372036854775808n
const toLong = (str) => {
  const num = typeof str == 'string' ? BigInt('0x' + str) : str
  if (num > MAX) return toLong(num - (1n << 64n))
  else if (num < MIN) return toLong(num + (1n << 64n))
  return num
}

const teaDecrypt = (data, key) => {
  const length = data.length
  const lengthBitint = BigInt(length)
  if (length >= 1) {
    let j2 = data[0]
    let j3 = toLong((6n + (52n / lengthBitint)) * DELTA)
    while (true) {
      const j4 = j3
      if (j4 == 0n) break
      const j5 = toLong(3n & toLong(j4 >> 2n))
      let j6 = lengthBitint
      while (true) {
        j6--
        if (j6 > 0n) {
          const j7 = data[(j6 - 1n)]
          const i = j6
          j2 = toLong(data[i] - (toLong(toLong(j2 ^ j4) + toLong(j7 ^ key[toLong(toLong(3n & j6) ^ j5)])) ^ toLong(toLong(toLong(j7 >> 5n) ^ toLong(j2 << 2n)) + toLong(toLong(j2 >> 3n) ^ toLong(j7 << 4n)))))
          data[i] = j2
        } else break
      }
      const j8 = data[lengthBitint - 1n]
      j2 = toLong(data[0n] - toLong(toLong(toLong(key[toLong(toLong(j6 & 3n) ^ j5)] ^ j8) + toLong(j2 ^ j4)) ^ toLong(toLong(toLong(j8 >> 5n) ^ toLong(j2 << 2n)) + toLong(toLong(j2 >> 3n) ^ toLong(j8 << 4n)))))
      data[0] = j2
      j3 = toLong(j4 - DELTA)
    }
  }
  return data
}

// https://stackoverflow.com/a/29132118
const longToBytes = (l) => {
  const result = Buffer.alloc(8)
  for (let i = 0; i < 8; i++) {
    result[i] = parseInt(l & 0xFFn)
    l >>= 8n
  }
  return result
}

const longArrToString = (data) => {
  const arrayList = []
  for (const j of data) arrayList.push(longToBytes(j).toString('utf16le'))
  return arrayList.join('')
}

const toBigintArray = (data) => {
  const length = Math.floor(data.length / 16)
  const jArr = Array(length)
  for (let i = 0; i < length; i++) {
    jArr[i] = toLong(data.substring(i * 16, (i * 16) + 16))
  }
  return jArr
}

const decrypt = (data) => {
  return (data == null || data.length < MIN_LENGTH)
    ? data
    : longArrToString(teaDecrypt(toBigintArray(data), keyArr))
}

// ---------------------------------------------------------------------------
// mrc / lrc 解析（原 mg/lyric.js）
// ---------------------------------------------------------------------------

const mrcTools = {
  rxps: {
    lineTime: /^\s*\[(\d+),\d+\]/,
    wordTime: /\(\d+,\d+\)/,
    wordTimeAll: /(\(\d+,\d+\))/g,
  },
  parseLyric(str) {
    str = str.replace(/\r/g, '')
    const lines = str.split('\n')
    const lxlrcLines = []
    const lrcLines = []

    for (const line of lines) {
      if (line.length < 6) continue
      const result = this.rxps.lineTime.exec(line)
      if (!result) continue

      const startTime = parseInt(result[1])
      let time = startTime
      const ms = time % 1000
      time /= 1000
      const m = parseInt(time / 60).toString().padStart(2, '0')
      time %= 60
      const s = parseInt(time).toString().padStart(2, '0')
      const timeTag = `[${m}:${s}.${ms}]`

      const words = line.replace(this.rxps.lineTime, '')

      lrcLines.push(`${timeTag}${words.replace(this.rxps.wordTimeAll, '')}`)

      let times = words.match(this.rxps.wordTimeAll)
      if (!times) continue
      times = times.map(t => {
        const r = /\((\d+),(\d+)\)/.exec(t)
        return `<${Math.max(parseInt(r[1]) - startTime, 0)},${r[2]}>`
      })
      const wordArr = words.split(this.rxps.wordTime)
      const newWords = times.map((t, index) => `${t}${wordArr[index]}`).join('')
      lxlrcLines.push(`${timeTag}${newWords}`)
    }
    return {
      lyric: lrcLines.join('\n'),
      lxlyric: lxlrcLines.join('\n'),
    }
  },
  getText(url, tryNum = 0) {
    const requestObj = httpFetch(url, { headers: MG_HEADERS, timeout: TIMEOUT_MS })
    return requestObj.promise.then(({ statusCode, body }) => {
      if (statusCode == 200) return body
      if (tryNum >= MAX_RETRY || statusCode == 404) throw new Error(`咪咕歌词请求失败（HTTP ${statusCode}）`)
      return this.getText(url, ++tryNum)
    })
  },
  getMrc(url) {
    return this.getText(url).then(text => {
      const raw = String(text ?? '')
      // 防御：明文 LRC 喂给 TEA 解密会抛 `Cannot convert 0x[00:01.00]… to a BigInt`。
      // 实测咪咕现在三个歌词地址返回的都是明文标准 LRC（mrcUrl 甚至已经不在搜索元数据里），
      // 所以只有"较长的纯十六进制串"才当密文处理，其余一律走 LRC 解析。
      if (!/^[0-9a-fA-F\s]{32,}$/.test(raw)) return this.getLrcFromText(raw)
      return this.parseLyric(decrypt(raw))
    })
  },
  getLrc(url) {
    return this.getText(url).then(text => this.getLrcFromText(String(text ?? '')))
  },
  /** 明文歌词 → LRC（没有时间标签时按 3 秒/行补假标签，见 lxserver 的同名补丁）。 */
  getLrcFromText(text) {
    const lines = text.split('\n')
    const hasTimeTag = /\[(\d+):(\d+)\.(\d+)\]/.test(text)

    if (hasTimeTag) {
      const linesWithTime = lines.filter(line => /\[(\d+):(\d+)\.(\d+)\]/.test(line))
      if (linesWithTime.length > lines.length * 0.5) {
        return { lxlyric: '', lyric: text }
      }
    }

    let currentTime = 0
    const lrcLines = lines.map((line) => {
      line = line.trim()
      if (!line || line.startsWith('@')) return ''
      const minutes = Math.floor(currentTime / 60)
      const seconds = currentTime % 60
      const timeTag = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.00]`
      currentTime += 3
      return `${timeTag}${line}`
    }).filter(line => line)

    return { lxlyric: '', lyric: lrcLines.join('\n') }
  },
  getTrc(url) {
    if (!url) return Promise.resolve('')
    return this.getText(url).then(text => String(text ?? ''))
  },
}

/** copyrightId → 咪咕资源详情（拿到 lrcUrl/mrcUrl/trcUrl）。 */
const getMusicInfo = (copyrightId) => {
  const requestObj = httpFetch('https://c.musicapp.migu.cn/MIGUM2.0/v1.0/content/resourceinfo.do?resourceType=2', {
    method: 'POST',
    form: { resourceId: String(copyrightId) },
    headers: MG_HEADERS,
    timeout: TIMEOUT_MS,
  })
  return requestObj.promise.then(({ body, statusCode }) => {
    if (statusCode !== 200) throw new Error(`咪咕歌词请求失败（HTTP ${statusCode}）`)
    const resource = body?.resource
    if (!Array.isArray(resource) || !resource.length) throw new Error('咪咕歌词获取失败')
    const item = resource[0]
    return {
      lrcUrl: item.lrcUrl,
      mrcUrl: item.mrcUrl,
      trcUrl: item.trcUrl,
    }
  })
}

const hasTimeLine = (lrc) => /\[\d{1,2}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(lrc)

const requestLyric = async (info) => {
  let source = info
  if (!source?.mrcUrl && !source?.lrcUrl) {
    if (!source?.copyrightId) throw new Error('咪咕歌词获取失败：缺少 mrcUrl/lrcUrl/copyrightId')
    source = await getMusicInfo(source.copyrightId)
  }

  const p = source.mrcUrl ? mrcTools.getMrc(source.mrcUrl) : (source.lrcUrl ? mrcTools.getLrc(source.lrcUrl) : null)
  if (p == null) throw new Error('咪咕歌词获取失败：没有可用的歌词地址')

  const [lrcInfo, tlyric] = await Promise.all([p, mrcTools.getTrc(source.trcUrl)])
  const base = lrcInfo?.lyric ?? ''
  if (!base.trim()) throw new Error('咪咕歌词获取失败')
  // mrc 路径一定是带时间轴的；lrc 路径已是标准 LRC 或已补过时间标签
  if (!hasTimeLine(base) && !source.mrcUrl) throw new Error('咪咕歌词获取失败')

  return {
    lyric: base,
    tlyric: tlyric || '',
    rlyric: '',
    lxlyric: lrcInfo?.lxlyric || '',
    format: 'lrc',
  }
}

export default {
  /**
   * @param {{ songmid?: string | number, copyrightId?: string, lrcUrl?: string, mrcUrl?: string, trcUrl?: string }} info
   * @returns {Promise<{ lyric: string, tlyric: string, rlyric: string, lxlyric: string, format: string }>}
   */
  async getLyric(info) {
    let lastErr
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        return await requestLyric(info)
      } catch (err) {
        lastErr = err
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('咪咕歌词获取失败')
  },
}
