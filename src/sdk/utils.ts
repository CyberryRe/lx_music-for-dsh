// SDK 公共工具：格式化与名称解码。
// 移植自 lx-music-desktop（Apache-2.0）的 musicSdk/index.js 与 musicSdk/utils.js；
// decodeName 原实现依赖浏览器 DOMParser，此处用轻量 HTML 实体解码替代。

import * as crypto from 'node:crypto'

export const toMD5 = (str: string): string => crypto.createHash('md5').update(str).digest('hex')

/** 轻量 HTML 实体解码（替代 DOMParser）。 */
export const decodeName = (str: string | null = ''): string => {
  if (!str) return ''
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
}

/** 格式化歌手名。 */
export const formatSingerName = (singers: unknown, nameKey = 'name', join = ' / '): string => {
  if (Array.isArray(singers)) {
    const singer: string[] = []
    singers.forEach((item) => {
      const name = isObject(item) ? item[nameKey] : undefined
      if (!name) return
      singer.push(String(name))
    })
    return decodeName(singer.join(join))
  }
  return decodeName(String(singers ?? ''))
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** 字节数格式化（B/KB/MB）。 */
export const sizeFormate = (size: number): string => {
  if (!size) return ''
  const num = 1024.0
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB']
  const i = Math.floor(Math.log(size) / Math.log(num))
  return `${(size / num ** i).toFixed(2)} ${units[i]}`
}

/** 秒/毫秒 → mm:ss（自适应单位：>10000 视为毫秒）。 */
export const formatPlayTime = (time: number): string => {
  let seconds = Number(time)
  if (!Number.isFinite(seconds)) return ''
  if (seconds > 10_000) seconds /= 1000
  seconds = Math.max(0, Math.floor(seconds))
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
