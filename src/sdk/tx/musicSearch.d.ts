// lx-music-desktop musicSdk 平台模块的类型声明（.js 原样移植，仅搜索路径使用）。

export interface SdkMusicItem {
  singer: string
  name: string
  albumName: string
  albumId?: string | number
  source: string
  interval: string
  songmid: string | number
  img?: string | null
  lrc?: string | null
  types?: Array<{ type: string; size: string | null; hash?: string }>
  _types?: Record<string, { size: string | null; hash?: string }>
  typeUrl?: Record<string, unknown>
  hash?: string
  copyrightId?: string
  strMediaMid?: string
  albumMid?: string
  [key: string]: unknown
}

export interface SdkSearchResult {
  list: SdkMusicItem[]
  total: number
  limit: number
  page: number
  allPage: number
}

declare const module: {
  limit: number
  total: number
  page: number
  allPage: number
  musicSearch(str: string, page: number, limit: number): { promise: Promise<{ body: unknown }>; canceleFn(): void }
  search(str: string, page?: number, limit?: number): Promise<SdkSearchResult>
  filterData?(raw: unknown): SdkMusicItem[]
  handleResult?(raw: unknown): SdkMusicItem[]
}

export default module
