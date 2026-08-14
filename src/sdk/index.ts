// 内置音乐 SDK 门面：移植 lx-music-desktop（Apache-2.0）的五平台搜索，
// 把各平台结果（旧版 MusicInfo 结构）规范化为插件 MusicInfo。
// 直链解析不在此处：与 lx-music-desktop v2.12.2 一致，由音源脚本引擎负责。

import kw from './kw/musicSearch.js'
import kg from './kg/musicSearch.js'
import tx from './tx/musicSearch.js'
import wy from './wy/musicSearch.js'
import mg from './mg/musicSearch.js'
import type { MusicInfo, MusicSource, Quality, SearchOutcome } from '../shared/types'
import { jsonSafe } from '../shared/json'
import type { SdkMusicItem, SdkSearchResult } from './musicSearch.d'

export type SdkModule = typeof import('./musicSearch.d').default

const PLATFORMS: Array<{ id: MusicSource; module: SdkModule }> = [
  { id: 'wy', module: wy as unknown as SdkModule },
  { id: 'tx', module: tx as unknown as SdkModule },
  { id: 'kg', module: kg as unknown as SdkModule },
  { id: 'kw', module: kw as unknown as SdkModule },
  { id: 'mg', module: mg as unknown as SdkModule },
]

/** 各平台直链能力声明（当前版本与 lx-music-desktop 一致：无内置直链，由音源脚本提供）。 */
export const SDK_BUILTIN_URL_SUPPORT: Partial<Record<MusicSource, boolean>> = {
  wy: false,
  tx: false,
  kg: false,
  kw: false,
  mg: false,
}

/** 旧版 SDK 条目 → 插件 MusicInfo（经 jsonSafe 清洗，避免 undefined 字段触发 gateway 边界校验）。 */
export function sdkItemToMusicInfo(item: SdkMusicItem): MusicInfo {
  const qualitys = (item.types ?? []).map((q) => ({ type: q.type as Quality, size: q.size ?? null }))
  return jsonSafe({
    id: `${item.source}_${item.songmid}`,
    name: item.name,
    singer: item.singer,
    source: item.source as MusicSource,
    interval: item.interval ?? null,
    meta: {
      songId: item.songmid,
      albumName: item.albumName ?? '',
      albumId: item.albumId,
      picUrl: item.img ?? null,
      qualitys,
      hash: item.hash,
      copyrightId: item.copyrightId,
      strMediaMid: item.strMediaMid,
      albumMid: item.albumMid,
    },
  })
}

/** 单平台搜索（返回规范化歌曲列表）。 */
export async function searchPlatform(source: MusicSource, query: string, limit = 20, page = 1): Promise<MusicInfo[]> {
  const platform = PLATFORMS.find((p) => p.id === source)
  if (!platform) throw new Error(`平台 ${source} 不受支持`)
  const result = (await platform.module.search(query, page, limit)) as SdkSearchResult | undefined
  if (!result || !Array.isArray(result.list)) return []
  return result.list.filter((item) => item && item.name).map(sdkItemToMusicInfo)
}

/** 带平台优先级的搜索编排（首个有结果的平台胜出）。 */
export async function searchWithPriority(
  query: string,
  options: { sources?: MusicSource[]; limit?: number; page?: number } = {},
): Promise<SearchOutcome> {
  const sources = options.sources && options.sources.length > 0 ? options.sources : (PLATFORMS.map((p) => p.id) as MusicSource[])
  const attempts: SearchOutcome['attempts'] = []
  for (const source of sources) {
    try {
      const list = await searchPlatform(source, query, options.limit ?? 20, options.page ?? 1)
      attempts.push({ source, status: list.length > 0 ? 'success' : 'fail', count: list.length })
      if (list.length > 0) return { results: list, usedSource: source, attempts }
    } catch (err) {
      attempts.push({ source, status: 'fail', count: 0, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return { results: [], usedSource: null, attempts }
}
