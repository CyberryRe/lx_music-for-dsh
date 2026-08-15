// 内置 mock 数据源：仅当 providerMode 为 mock 时提供搜索与直链解析（无 lxServerUrl 时默认
// 走内置引擎，不会进入 mock），便于无网络演示、开发与单元测试。搜索基于关键词子串匹配，
// 直链为示例音频 URL（可播放的样例音频）。

import type { MusicInfo, MusicSource, MusicUrlResult, Quality, SearchOutcome } from './shared/types'

interface MockSongSeed {
  name: string
  singer: string
  source: MusicSource
  interval: string
  album?: string
}

const SEEDS: MockSongSeed[] = [
  { name: '晴天', singer: '周杰伦', source: 'wy', interval: '04:29', album: '叶惠美' },
  { name: '七里香', singer: '周杰伦', source: 'wy', interval: '04:59', album: '七里香' },
  { name: '稻香', singer: '周杰伦', source: 'wy', interval: '03:43', album: '魔杰座' },
  { name: '夜曲', singer: '周杰伦', source: 'kg', interval: '03:47', album: '十一月的萧邦' },
  { name: '青花瓷', singer: '周杰伦', source: 'kg', interval: '03:59', album: '我很忙' },
  { name: '平凡之路', singer: '朴树', source: 'wy', interval: '05:02', album: '猎户星座' },
  { name: '生如夏花', singer: '朴树', source: 'tx', interval: '04:44', album: '生如夏花' },
  { name: '那些花儿', singer: '朴树', source: 'tx', interval: '04:54', album: '我去2000年' },
  { name: '海阔天空', singer: 'Beyond', source: 'mg', interval: '05:24', album: '乐与怒' },
  { name: '光辉岁月', singer: 'Beyond', source: 'mg', interval: '04:57', album: '命运派对' },
  { name: '真的爱你', singer: 'Beyond', source: 'kw', interval: '04:37', album: 'Beyond IV' },
  { name: '后来', singer: '刘若英', source: 'kw', interval: '05:36', album: '我等你' },
  { name: '成都', singer: '赵雷', source: 'wy', interval: '05:28', album: '无法长大' },
  { name: '理想', singer: '赵雷', source: 'kg', interval: '05:21', album: '吉姆餐厅' },
  { name: '起风了', singer: '买辣椒也用券', source: 'tx', interval: '05:25', album: '起风了' },
  { name: 'Lemon', singer: '米津玄師', source: 'mg', interval: '04:16', album: 'BOOTLEG' },
  { name: 'Lemon Tree', singer: "Fool's Garden", source: 'mg', interval: '03:11', album: 'Dish of the Day' },
]

/** 演示音频（公开样例，可被 HTML5 Audio 直接播放）。 */
const DEMO_AUDIO = 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3'
const DEMO_COVER = 'https://picsum.photos/seed/lxmusic/200/200'

function seedToMusic(seed: MockSongSeed, index: number): MusicInfo {
  const id = `mock-${seed.source}-${index}-${seed.name}`
  return {
    id,
    name: seed.name,
    singer: seed.singer,
    source: seed.source,
    interval: seed.interval,
    meta: {
      songId: id,
      albumName: seed.album ?? '未知专辑',
      picUrl: DEMO_COVER,
      qualitys: [
        { type: '128k', size: '3.6M' },
        { type: '320k', size: '9.2M' },
        { type: 'flac', size: '28.4M' },
      ],
    },
  }
}

export interface MockProviderOptions {
  /** 固定延迟（模拟网络），默认 120ms。 */
  latencyMs?: number
}

export class MockProvider {
  private readonly latencyMs: number

  constructor(options: MockProviderOptions = {}) {
    this.latencyMs = options.latencyMs ?? 120
  }

  private async delay(): Promise<void> {
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs))
  }

  private matches(seed: MockSongSeed, query: string, singer?: string): boolean {
    const q = query.trim().toLowerCase()
    if (!q) return true
    const hitName = seed.name.toLowerCase().includes(q)
    const hitSinger = seed.singer.toLowerCase().includes(q)
    // 支持 "歌手 歌名" 双关键词
    const words = q.split(/\s+/)
    const allWords = words.every((w) => seed.name.toLowerCase().includes(w) || seed.singer.toLowerCase().includes(w))
    if (singer) {
      const s = singer.trim().toLowerCase()
      return (hitName || hitSinger || allWords) && seed.singer.toLowerCase().includes(s)
    }
    return hitName || hitSinger || allWords
  }

  /** 搜索（支持来源过滤与平台优先级）。 */
  async search(
    query: string,
    options: { sources?: MusicSource[]; singer?: string; limit?: number } = {},
  ): Promise<SearchOutcome> {
    await this.delay()
    const sources: MusicSource[] = options.sources && options.sources.length > 0 ? options.sources : ['wy', 'tx', 'kg', 'kw', 'mg']
    const attempts: SearchOutcome['attempts'] = []
    const seen = new Set<string>()
    const results: MusicInfo[] = []
    let usedSource: MusicSource | null = null
    for (const source of sources) {
      const hits = SEEDS.filter((s) => s.source === source && this.matches(s, query, options.singer))
      if (hits.length > 0 && usedSource === null) usedSource = source
      for (const hit of hits) {
        const music = seedToMusic(hit, SEEDS.indexOf(hit))
        const dedupeKey = `${music.name}|${music.singer}`
        if (!seen.has(dedupeKey)) {
          seen.add(dedupeKey)
          results.push(music)
        }
      }
      attempts.push({ source, status: hits.length > 0 ? 'success' : 'fail', count: hits.length })
      if (results.length >= (options.limit ?? 20)) break
    }
    return { results: results.slice(0, options.limit ?? 20), usedSource, attempts }
  }

  /** 直链解析：直接返回演示音频 URL。 */
  async resolveUrl(music: MusicInfo, quality: Quality): Promise<MusicUrlResult> {
    await this.delay()
    return {
      url: DEMO_AUDIO,
      type: quality,
      sourceName: 'mock',
      attempts: [{ name: 'mock', status: 'success', message: `mock 解析 ${quality}` }],
    }
  }
}
