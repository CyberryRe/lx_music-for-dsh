// 各平台歌词模块（`src/sdk/<平台>/lyric.js`，原样移植 lx-music-desktop / lxserver）的统一类型声明。
//
// 与 `musicSearch.d.ts` 同一套路：五个平台各自的 `lyric.d.ts` 只做转发，类型本体只有这一份。

/** 歌词请求入参（由 `src/sdk/lyric.ts` 的 `buildLyricSongInfo()` 从 MusicInfo 生成）。 */
export interface SdkLyricSongInfo {
  /** 歌曲名（kg 用它做歌词检索；也可能被平台当作兜底关键字）。 */
  name: string
  singer?: string
  /** "03:55"（kg 用它算 timelength）。 */
  interval?: string
  /** kw=酷我 rid（纯数字）；wy=网易数字 id；tx=QQ songmid；kg=Audioid。 */
  songmid?: string | number
  /** kg FileHash。 */
  hash?: string
  /** mg 版权 id。 */
  copyrightId?: string
  /** mg 歌词直链（搜索元数据里就带）。 */
  lrcUrl?: string
  /** mg MRC 逐字歌词直链。 */
  mrcUrl?: string
  /** mg 翻译歌词直链。 */
  trcUrl?: string
}

/** 平台返回的歌词原文（未解析成行）。 */
export interface SdkLyricPayload {
  /** 标准 LRC（必须带时间标签）。 */
  lyric: string
  /** 翻译。 */
  tlyric?: string
  /** 音译。 */
  rlyric?: string
  /** 逐字 LRC：`[mm:ss.xxx]<起点ms,时长ms>字<…>字`。 */
  lxlyric?: string
  /** 实际格式：lrc / lxlyric / krc / mrc。 */
  format?: string
}

export interface SdkLyricModule {
  getLyric(info: SdkLyricSongInfo): Promise<SdkLyricPayload>
}

declare const module: SdkLyricModule

export default module
