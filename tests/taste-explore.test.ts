// 探索（同艺人未听曲目）测试：纯排序器 + music_profile 的 explore-brief 视图。
import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { PlaybackService } from '../src/playback'
import { SlidingWindowRateLimiter } from '../src/ratelimit'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import type { MusicInfo } from '../src/shared/types'
import type { StorageFace } from '../src/playback'
import { TasteStore } from '../src/taste/store'
import { registerTasteTools } from '../src/taste/tools'
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../src/taste/config'
import { EXPLORE_COOLDOWN_DAYS, rankUnheardCandidates, type ExploreSeed, type ExploreSearchItem } from '../src/taste/explore'

interface ToolLike {
  name: string
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>
  description: string
}

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)

const item = (name: string, singer: string, over: Partial<ExploreSearchItem> = {}): ExploreSearchItem => ({
  name,
  singer,
  source: 'wy',
  id: `wy_${name}`,
  albumName: '专辑',
  interval: '04:00',
  ...over,
})

const seed = (name: string, score = 5): ExploreSeed => ({ key: name, raw: name, score, confidence: 'medium' })

describe('rankUnheardCandidates（纯函数）', () => {
  it('排除已经听过的歌', () => {
    const out = rankUnheardCandidates({
      seeds: [seed('周杰伦')],
      resultsBySeed: new Map([['周杰伦', [item('晴天', '周杰伦'), item('稻香', '周杰伦')]]]),
      playedKeys: new Set(['晴天|周杰伦']),
      recentlyExplored: new Set(),
    })
    expect(out.map((c) => c.title)).toEqual(['稻香'])
  })

  it('排除冷却期内探索过的歌（同一首不反复推）', () => {
    const out = rankUnheardCandidates({
      seeds: [seed('周杰伦')],
      resultsBySeed: new Map([['周杰伦', [item('晴天', '周杰伦'), item('稻香', '周杰伦')]]]),
      playedKeys: new Set(),
      recentlyExplored: new Set(['晴天|周杰伦']),
    })
    expect(out.map((c) => c.title)).toEqual(['稻香'])
  })

  it('不把翻唱/Live 当"新歌"推（探索也要版本过滤）', () => {
    const out = rankUnheardCandidates({
      seeds: [seed('周杰伦')],
      resultsBySeed: new Map([
        [
          '周杰伦',
          [
            item('晴天 (Live)', '周杰伦', { albumName: '演唱会' }),
            item('晴天 (伴奏)', '周杰伦'),
            item('晴天 (原唱 周杰伦)', 'RyaVocal'),
            item('七里香', '周杰伦'),
          ],
        ],
      ]),
      playedKeys: new Set(),
      recentlyExplored: new Set(),
    })
    expect(out.map((c) => c.title)).toEqual(['七里香'])
  })

  it('过滤掉搜索噪声（别的艺人的歌）', () => {
    const out = rankUnheardCandidates({
      seeds: [seed('周杰伦')],
      resultsBySeed: new Map([['周杰伦', [item('晴天', '周杰伦'), item('像晴天像雨天', '汪苏泷')]]]),
      playedKeys: new Set(),
      recentlyExplored: new Set(),
    })
    expect(out.map((c) => c.artist)).toEqual(['周杰伦'])
  })

  it('跨种子轮流取，保证一次探索不只推同一位艺人', () => {
    const out = rankUnheardCandidates({
      seeds: [seed('周杰伦', 9), seed('朴树', 5)],
      resultsBySeed: new Map([
        ['周杰伦', [item('稻香', '周杰伦'), item('夜曲', '周杰伦'), item('青花瓷', '周杰伦')]],
        ['朴树', [item('平凡之路', '朴树'), item('生如夏花', '朴树')]],
      ]),
      playedKeys: new Set(),
      recentlyExplored: new Set(),
      limit: 4,
    })
    // 轮流：周杰伦、朴树、周杰伦、朴树
    expect(out.map((c) => c.artist)).toEqual(['周杰伦', '朴树', '周杰伦', '朴树'])
  })

  it('不同种子返回同一首歌时只出现一次', () => {
    const out = rankUnheardCandidates({
      seeds: [seed('周杰伦'), seed('周杰伦（合唱）')],
      resultsBySeed: new Map([
        ['周杰伦', [item('稻香', '周杰伦')]],
        ['周杰伦（合唱）', [item('稻香', '周杰伦')]],
      ]),
      playedKeys: new Set(),
      recentlyExplored: new Set(),
    })
    expect(out).toHaveLength(1)
  })

  it('理由里说明来自哪位常听艺人（可解释）', () => {
    const out = rankUnheardCandidates({
      seeds: [seed('周杰伦')],
      resultsBySeed: new Map([['周杰伦', [item('稻香', '周杰伦')]]]),
      playedKeys: new Set(),
      recentlyExplored: new Set(),
    })
    expect(out[0]?.reason).toContain('周杰伦')
    expect(out[0]?.reason).toContain('没听过')
  })

  it('尊重 limit；没有候选时返回空数组', () => {
    const many = Array.from({ length: 10 }, (_, i) => item(`歌${i}`, '周杰伦'))
    const out = rankUnheardCandidates({
      seeds: [seed('周杰伦')],
      resultsBySeed: new Map([['周杰伦', many]]),
      playedKeys: new Set(),
      recentlyExplored: new Set(),
      limit: 3,
    })
    expect(out).toHaveLength(3)
    expect(
      rankUnheardCandidates({ seeds: [], resultsBySeed: new Map(), playedKeys: new Set(), recentlyExplored: new Set() }),
    ).toHaveLength(0)
  })
})

// ── 工具层：explore-brief ────────────────────────────────────────────────────

function fakeStorage(): StorageFace & { raw: Map<string, Map<string, unknown>> } {
  const raw = new Map<string, Map<string, unknown>>()
  return {
    raw,
    global: { get: () => undefined, set: async () => {} },
    table: (name: string) => {
      if (!raw.has(name)) raw.set(name, new Map())
      const t = raw.get(name)!
      return {
        get: (k: string) => t.get(k),
        put: async (k: string, v: unknown) => {
          t.set(k, v)
        },
        entries: () => t.entries(),
        delete: async (k: string) => t.delete(k),
      }
    },
  }
}

const MUSIC: MusicInfo = {
  id: 'wy_186016',
  name: '晴天',
  singer: '周杰伦',
  source: 'wy',
  interval: '04:29',
  meta: { songId: '186016', albumName: '叶惠美' },
}

function makeHarness(options: { memory?: Partial<MemoryConfig> } = {}) {
  const storage = fakeStorage()
  const store = new TasteStore(storage, { now: () => T0 })
  const memory: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, ...options.memory }
  const service = new PlaybackService(new Context(), {
    settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' },
    rateLimiter: new SwingLimiter(),
  })
  const tools: ToolLike[] = []
  registerTasteTools({ tools: { register: (t) => tools.push(t as ToolLike) } }, { service, store, memory, now: () => T0 })
  const profile = tools.find((t) => t.name === 'music_profile')!
  return { store, service, profile }
}

/** mock provider 有 120ms 延迟，测试里给足限流额度。 */
class SwingLimiter extends SlidingWindowRateLimiter {
  constructor() {
    super({ maxCalls: 100, windowMs: 60_000 })
  }
}

/** 给某位艺人积累足够的收听证据（medium 置信度 → 允许 proactive）。 */
async function seedArtist(store: TasteStore, artist: string, times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await store.applyDeltas([{ kind: 'artist', key: artist, signal: 2, reason: '完整播放', provenance: 'implicit' }], {
      now: T0,
      halfLifeDays: 90,
    })
  }
}

describe('music_profile({view:"explore-brief"})', () => {
  it('样本不足时明确说"数据不够"，不硬凑候选', async () => {
    const { profile } = makeHarness()
    const out = await profile.execute({ view: 'explore-brief' }, {})
    expect(String(out.summary)).toContain('没有足够的数据')
    expect(out.tracks).toHaveLength(0)
  })

  it('给出同艺人的未听曲目（排除已经听过的）', async () => {
    const { store, profile } = makeHarness()
    await seedArtist(store, '周杰伦')
    await store.upsertTrackRef({ trackKey: '晴天|周杰伦', title: '晴天', artist: '周杰伦', music: MUSIC, played: true, resolved: true })

    const out = await profile.execute({ view: 'explore-brief' }, {})
    const tracks = out.tracks as Array<{ title: string; artist: string; status: string; reason: string }>
    expect(tracks.length).toBeGreaterThan(0)
    expect(tracks.every((t) => t.artist === '周杰伦')).toBe(true)
    expect(tracks.some((t) => t.title === '晴天')).toBe(false) // 听过的不能再推
    expect(tracks.every((t) => t.status === 'unheard')).toBe(true)
    expect(String(out.note)).toContain('mode')
  })

  it('冷却期内探索过的曲目不再重复推（去重窗口）', async () => {
    const { store, profile } = makeHarness()
    await seedArtist(store, '周杰伦')
    // 标记"稻香"刚被探索过
    await store.upsertTrackRef({ trackKey: '稻香|周杰伦', title: '稻香', artist: '周杰伦', music: { ...MUSIC, id: 'wy_2', name: '稻香' }, played: false, explored: true, now: T0 })

    const out = await profile.execute({ view: 'explore-brief' }, {})
    const titles = (out.tracks as Array<{ title: string }>).map((t) => t.title)
    expect(titles).not.toContain('稻香')
    // 冷却窗口常量被真正使用（60 天）
    expect(EXPLORE_COOLDOWN_DAYS).toBe(60)
    expect(store.recentlyExplored(T0 + 10 * DAY, EXPLORE_COOLDOWN_DAYS).has('稻香|周杰伦')).toBe(true)
    expect(store.recentlyExplored(T0 + 61 * DAY, EXPLORE_COOLDOWN_DAYS).has('稻香|周杰伦')).toBe(false)
  })

  it('画像关闭时探索也返回"已关闭"，不做任何搜索', async () => {
    const { profile } = makeHarness({ memory: { enabled: false } })
    const out = await profile.execute({ view: 'explore-brief' }, {})
    expect(String(out.summary)).toContain('已关闭')
    expect(out.tracks).toHaveLength(0)
  })
})
