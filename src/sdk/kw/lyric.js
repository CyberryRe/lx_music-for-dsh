// 移植自 lxserver musicSdk/kw（Apache-2.0）：kw（酷我）歌词获取。
// 原实现依赖 kw/util.js 的 decodeLyric（iconv-lite + zlib）与 lrcTools；
// 此处把两个 helper 内联在本文件，并用 Node 内置 TextDecoder('gb18030') 取代 iconv-lite。
//
// 公开接口：getLyric(info) → Promise<LyricPayload>，info.songmid = 酷我数字 rid
// （musicSearch.js 里 MUSICRID.replace('MUSIC_','')，纯数字，不带前缀）。
import { inflate } from 'node:zlib'
import { httpFetch } from '../request'
import { decodeName } from '../utils'

/** 请求超时（参考实现不设，这里按仓库约定 8-12s）。 */
const TIMEOUT_MS = 10_000
/** 单平台内部重试上限。 */
const MAX_RETRY = 2

// ---------------------------------------------------------------------------
// decodeLyric（原 kw/util.js，去掉 iconv-lite）
// ---------------------------------------------------------------------------

const bufKey = Buffer.from('yeelion')
const bufKeyLen = bufKey.length

/** 与 kw/util.js 的 buildParams 等价：XOR 混淆 + base64。 */
const buildParams = (id, isGetLyricx) => {
  let params = `user=12345,web,web,web&requester=localhost&req=1&rid=MUSIC_${id}`
  if (isGetLyricx) params += '&lrcx=1'
  const bufStr = Buffer.from(params)
  const bufStrLen = bufStr.length
  const output = new Uint16Array(bufStrLen)
  let i = 0
  while (i < bufStrLen) {
    let j = 0
    while (j < bufKeyLen && i < bufStrLen) {
      output[i] = bufKey[j] ^ bufStr[i]
      i++
      j++
    }
  }
  return Buffer.from(output).toString('base64')
}

const handleInflate = (data) => new Promise((resolve, reject) => {
  inflate(data, (err, result) => {
    if (err) {
      reject(err)
      return
    }
    resolve(result)
  })
})

const gb18030Decode = (buf) => new TextDecoder('gb18030').decode(buf)

/** 原 kw/util.js#decodeLyricInternal：解 xored/inflated 歌词，返回 base64。 */
const decodeLyricInternal = async (buf, isGetLyricx) => {
  if (buf.toString('utf8', 0, 10) != 'tp=content') return ''
  const lrcData = await handleInflate(buf.subarray(buf.indexOf('\r\n\r\n') + 4))

  if (!isGetLyricx) return gb18030Decode(lrcData)

  const bufStr = Buffer.from(lrcData.toString(), 'base64')
  const bufStrLen = bufStr.length
  const output = new Uint8Array(bufStrLen)
  let i = 0
  while (i < bufStrLen) {
    let j = 0
    while (j < bufKeyLen && i < bufStrLen) {
      output[i] = bufStr[i] ^ bufKey[j]
      i++
      j++
    }
  }

  return gb18030Decode(Buffer.from(output))
}

/** 原 kw/util.js#decodeLyric：入参出参都是 base64。 */
const decodeLyric = async ({ lrcBase64, isGetLyricx }) => {
  const lrc = await decodeLyricInternal(Buffer.from(lrcBase64, 'base64'), isGetLyricx)
  return Buffer.from(lrc).toString('base64')
}

// ---------------------------------------------------------------------------
// lrcTools（原 kw/util.js，逐字时间轴解析）
// ---------------------------------------------------------------------------

const lrcTools = {
  rxps: {
    wordLine: /^(\[\d{1,2}:.*\d{1,4}\])\s*(\S+(?:\s+\S+)*)?\s*/,
    tagLine: /\[(ver|ti|ar|al|offset|by|kuwo):\s*(\S+(?:\s+\S+)*)\s*\]/,
    wordTimeAll: /<(-?\d+),(-?\d+)(?:,-?\d+)?>/g,
    wordTime: /<(-?\d+),(-?\d+)(?:,-?\d+)?>/,
  },
  offset: 1,
  offset2: 1,
  /**
   * 逐字时间轴是否可信。
   *
   * 上游在 `[kuwo:NNN]` 的十位/个位出现 0 时直接判失败（`isOK = false` → 整首抛错）。
   * 那个硬失败是**有意义的**：offset/offset2 是换算逐字时间的除数，缺一个就只能瞎猜，
   * 猜错会把高亮打到别的字上。这里保留"放弃逐字轴"的语义，但改成返回空串而不是抛错
   * ——调用方本来就把它当"没有逐字歌词"，整行 LRC 仍然可用。
   */
  wordsOk: true,
  lines: [],
  tags: [],
  getWordInfo(str, str2, prevWord) {
    const offset = parseInt(str)
    const offset2 = parseInt(str2)
    const startTime = Math.abs((offset + offset2) / (this.offset * 2))
    const endTime = Math.abs((offset - offset2) / (this.offset2 * 2)) + startTime
    if (prevWord) {
      if (startTime < prevWord.endTime) {
        prevWord.endTime = startTime
        if (prevWord.startTime > prevWord.endTime) {
          prevWord.startTime = prevWord.endTime
        }
        prevWord.newTimeStr = `<${prevWord.startTime},${prevWord.endTime - prevWord.startTime}>`
      }
    }
    return {
      startTime,
      endTime,
      timeStr: `<${startTime},${endTime - startTime}>`,
    }
  },
  parseLine(line) {
    if (line.length < 6) return
    let result = this.rxps.wordLine.exec(line)
    if (result) {
      const time = result[1]
      let words = result[2]
      if (words == null) words = ''
      const wordTimes = words.match(this.rxps.wordTimeAll)
      if (!wordTimes) return
      let preTimeInfo
      for (const timeStr of wordTimes) {
        const result = this.rxps.wordTime.exec(timeStr)
        // ⚠️ 不要按"第二个数是不是负数"来筛标签：酷我**每行的第一个词**就是
        // `<a,-a>` 这种形式（例如 `[00:02.250]<3150,-3150>词<6750,450>：…`），
        // 而 getWordInfo 会把 `(3150,-3150)` 正确换算成 `<0,450>`。
        // 早期版本把它当成"行级标记"删掉，导致每行的**第一个字**在逐字渲染时消失
        // （UI 对当前行只渲染 words）——这是实测回归，别再加回来。
        const wordInfo = this.getWordInfo(result[1], result[2], preTimeInfo)
        words = words.replace(timeStr, wordInfo.timeStr)
        if (preTimeInfo?.newTimeStr) words = words.replace(preTimeInfo.timeStr, preTimeInfo.newTimeStr)
        preTimeInfo = wordInfo
      }
      this.lines.push(time + words)
      return
    }
    result = this.rxps.tagLine.exec(line)
    if (!result) return
    if (result[1] == 'kuwo') {
      let content = result[2]
      if (content != null && content.includes('][')) content = content.substring(0, content.indexOf(']['))
      const valueOf = parseInt(content, 8)
      const offset = Math.trunc(valueOf / 10)
      const offset2 = Math.trunc(valueOf % 10)
      // 与上游一致：除数为 0（或解析不出）时放弃整首的逐字轴，不猜比例。
      if (!Number.isFinite(offset) || offset <= 0 || !Number.isFinite(offset2) || offset2 <= 0) {
        this.wordsOk = false
        return
      }
      this.offset = offset
      this.offset2 = offset2
    } else {
      this.tags.push(line)
    }
  },
  parse(lrc) {
    const lines = lrc.split(/\r\n|\r|\n/)
    const tools = Object.create(this)
    tools.wordsOk = true
    tools.offset = 1
    tools.offset2 = 1
    tools.lines = []
    tools.tags = []

    for (const line of lines) {
      tools.parseLine(line)
      if (!tools.wordsOk) return ''
    }
    if (!tools.lines.length) return ''
    let lrcs = tools.lines.join('\n')
    if (tools.tags.length) lrcs = `${tools.tags.join('\n')}\n${lrcs}`
    return lrcs
  },
}

// ---------------------------------------------------------------------------
// lyric（原 kw/lyric.js）
// ---------------------------------------------------------------------------

// ⚠️ 这里是**非全局**正则（上游带 /g）：`.exec()` 会保留 lastIndex，而模式是 `^` 锚定的，
// 连续 exec 会**每隔一行丢一行**（第 1 行命中后 lastIndex>0，第 2 行从 lastIndex 起匹配必然
// 失败并重置）。照抄上游会让一半歌词消失，实测确认。
const timeExp = /^\[([\d:.]*)\]{1}/
const existTimeExp = /\[\d{1,2}:.*\d{1,4}\]/
const lyricxTag = /^<-?\d+,-?\d+>/

const sortLrcArr = (arr) => {
  const lrcSet = new Set()
  let lrc = []
  const lrcT = []

  let isLyricx = false
  for (const item of arr) {
    if (lrcSet.has(item.time)) {
      if (lrc.length < 2) continue
      const tItem = lrc.pop()
      tItem.time = lrc[lrc.length - 1].time
      lrcT.push(tItem)
      lrc.push(item)
    } else {
      lrc.push(item)
      lrcSet.add(item.time)
    }
    if (!isLyricx && lyricxTag.test(item.text)) isLyricx = true
  }

  if (!isLyricx && lrcT.length > lrc.length * 0.3 && lrc.length - lrcT.length > 6) {
    throw new Error('failed')
  }

  return { lrc, lrcT }
}

const transformLrc = (tags, lrclist) => {
  return `${tags.join('\n')}\n${lrclist ? lrclist.map(l => `[${l.time}]${l.text}\n`).join('') : '暂无歌词'}`
}

const parseLrc = (lrc) => {
  const lines = lrc.split(/\r\n|\r|\n/)
  const tags = []
  const lrcArr = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim()
    const result = timeExp.exec(line)
    if (result) {
      const text = line.replace(timeExp, '').trim()
      let time = RegExp.$1
      if (/\.\d\d$/.test(time)) time += '0'
      lrcArr.push({ time, text })
    } else if (lrcTools.rxps.tagLine.test(line)) {
      tags.push(line)
    }
  }
  const lrcInfo = sortLrcArr(lrcArr)
  return {
    lyric: decodeName(transformLrc(tags, lrcInfo.lrc)),
    tlyric: lrcInfo.lrcT.length ? decodeName(transformLrc(tags, lrcInfo.lrcT)) : '',
  }
}

/** 酷我返回的（base64 包装的、gb18030 编码的）整包歌词文本 → LyricPayload。 */
const parseLrcText = (lrcText) => {
  let lrcInfo
  try {
    lrcInfo = parseLrc(lrcText)
  } catch {
    throw new Error('酷我歌词解析失败')
  }

  if (lrcInfo.tlyric) lrcInfo.tlyric = lrcInfo.tlyric.replace(lrcTools.rxps.wordTimeAll, '')
  try {
    lrcInfo.lxlyric = lrcTools.parse(lrcInfo.lyric)
  } catch {
    lrcInfo.lxlyric = ''
  }
  lrcInfo.lyric = lrcInfo.lyric.replace(lrcTools.rxps.wordTimeAll, '')

  if (!existTimeExp.test(lrcInfo.lyric)) throw new Error('酷我歌词解析失败')

  return {
    lyric: lrcInfo.lyric,
    tlyric: lrcInfo.tlyric || '',
    rlyric: '',
    lxlyric: lrcInfo.lxlyric || '',
    format: 'lrc',
  }
}

/**
 * 走 newlyric.kuwo.cn（lx 参考实现主路径，带逐字时间轴 lrcx=1）。
 */
const getLyricx = (rid) => {
  const requestObj = httpFetch(`https://newlyric.kuwo.cn/newlyric.lrc?${buildParams(rid, true)}`, { timeout: TIMEOUT_MS })
  return requestObj.promise.then(({ statusCode, body, raw }) => {
    if (statusCode !== 200) throw new Error(`酷我歌词请求失败（HTTP ${statusCode}）：${String(body).slice(0, 120)}`)
    return decodeLyric({ lrcBase64: raw.toString('base64'), isGetLyricx: true }).then((base64Data) => {
      const lrcText = Buffer.from(base64Data, 'base64').toString()
      return parseLrcText(lrcText)
    })
  })
}

/**
 * 备选：m.kuwo.cn 的 songinfoandlrc（只有整行时间轴，没有逐字）。
 * 逐字接口偶发返回空包时兜底，避免整平台不可用。
 */
const getLyricFallback = (rid) => {
  const requestObj = httpFetch(`https://m.kuwo.cn/newh5/singles/songinfoandlrc?musicId=${rid}`, { timeout: TIMEOUT_MS })
  return requestObj.promise.then(({ statusCode, body }) => {
    if (statusCode !== 200) throw new Error(`酷我歌词请求失败（HTTP ${statusCode}）`)
    const data = body?.data
    if (!data?.lrclist?.length) throw new Error('酷我歌词获取失败')

    const lrcArr = []
    for (const item of data.lrclist) {
      const text = String(item.lineLyric ?? '').replace(/<\d+,\d+(?:,-?\d+)?>/g, '')
      // 接口返回的是秒（字符串，如 "31.20"），转成 [mm:ss.xxx]
      const sec = parseFloat(item.time)
      if (!Number.isFinite(sec)) continue
      const ms = Math.round(sec * 1000)
      const time = `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}.${String(ms % 1000).padStart(3, '0')}`
      lrcArr.push({ time, text })
    }
    if (!lrcArr.length) throw new Error('酷我歌词获取失败')

    const info = data.songinfo || {}
    const tags = []
    if (info.songName) tags.push(`[ti:${info.songName}]`)
    if (info.artist) tags.push(`[ar:${info.artist}]`)
    if (info.album) tags.push(`[al:${info.album}]`)
    const lyric = decodeName(transformLrc(tags, lrcArr))
    if (!existTimeExp.test(lyric)) throw new Error('酷我歌词获取失败')
    return { lyric, tlyric: '', rlyric: '', lxlyric: '', format: 'lrc' }
  })
}

export default {
  /**
   * @param {{ name?: string, singer?: string, songmid: string | number }} info
   * @returns {Promise<{ lyric: string, tlyric: string, rlyric: string, lxlyric: string, format: string }>}
   */
  async getLyric(info) {
    const rid = String(info?.songmid ?? '').replace(/^MUSIC_/, '')
    if (!/^\d+$/.test(rid)) throw new Error('酷我歌词获取失败：缺少有效的 songmid')

    let lastErr
    for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
      try {
        return await getLyricx(rid)
      } catch (err) {
        lastErr = err
      }
    }
    try {
      return await getLyricFallback(rid)
    } catch (err) {
      lastErr = err
    }
    throw lastErr instanceof Error ? lastErr : new Error('酷我歌词获取失败')
  },
}
