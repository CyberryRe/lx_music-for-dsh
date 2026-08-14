// kw 搜索专用工具（从 lx-music-desktop kw/util.js 提取，Apache-2.0）。
// 原文件的 IPC 歌词解码（decodeLyric）与 wbdCrypto（直链）不属于搜索路径，此处裁剪。

export const objStr2JSON = (str: string): unknown => {
  return JSON.parse(str.replace(/('(?=(,\s*')))|('(?=:))|((?<=([:,]\s*))')|((?<={)')|('(?=}))/g, '"'))
}

export const formatSinger = (rawData: string): string => rawData.replace(/&/g, '、')
