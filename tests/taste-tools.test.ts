// 画像工具集测试：music_profile（读）/ music_play_song（两级精确点播）/ music_taste（读写）。
//
// 这里锁的是**产品行为**，不是实现细节：
//   - Tier-1 命中时**一次搜索都不发生**（用"search 一被调用就抛错"来证明）；
//   - Tier-2 确认不到就明确失败，绝不拿翻唱/别的版本顶替；
//   - 显式指定版本是硬要求（要 Live 不能给原唱）；
//   - 画像是"按事件计费"的：profile 输出有上限、理由截断。

import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { PlaybackService } from '../src/playback'
import { SlidingWindowRateLimiter } from '../src/ratelimit'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import type { MusicInfo } from '../src/shared/types'
import type { StorageFace } from '../src/playback'
import { TasteStore } from '../src/taste/store'
import { registerTasteTools, TASTE_TOOL_NAMES } from '../src/taste/tools'
import { DEFAULT_MEMORY_CONFIG, type MemoryConfig } from '../src/taste/config'

interface ToolLike {
  name: string
  execute(args: unknown, exec: unknown): Promise<Record<string, unknown>>
  output: { render(args: unknown, value: unknown): unknown[] }
  description: string
  parameters: unknown
}

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
  meta: { songId: '186016', albumName: '叶惠美', qualitys: [{ type: '320k', size: '9.2M' }] },
}

function makeHarness(options: { memory?: Partial<MemoryConfig> } = {}) {
  const storage = fakeStorage()
  const store = new TasteStore(storage)
  const memory: MemoryConfig = { ...DEFAULT_MEMORY_CONFIG, enabled: true, ...options.memory }
  const service = new PlaybackService(new Context(), {
    settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' },
    rateLimiter: new SlidingWindowRateLimiter({ maxCalls: 50, windowMs: 60_000 }),
  })
  const tools: ToolLike[] = []
  registerTasteTools({ tools: { register: (t) => tools.push(t as ToolLike) } }, { service, store, memory })
  const byName = (name: string): ToolLike => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`tool ${name} 未注册`)
    return tool
  }
  return { service, store, storage, memory, tools, byName }
}

describe('注册', () => {
  it('注册三个画像工具', () => {
    const { tools } = makeHarness()
    expect(tools.map((t) => t.name).sort()).toEqual([...TASTE_TOOL_NAMES].sort())
  })

  it('工具描述不含动态内容（保持 prompt 缓存友好）', () => {
    const { tools } = makeHarness()
    for (const tool of tools) {
      // 描述里不该出现时间戳/分数这类会变的东西
      expect(/\d{4}-\d{2}-\d{2}|\d+\.\d{2}/.test(tool.description)).toBe(false)
    }
  })
})

describe('music_profile', () => {
  it('有数据时给出摘要、艺人榜与可直取的曲目候选', async () => {
    const { byName, store } = makeHarness()
    await store.applyDeltas(
      [
        { kind: 'artist', key: '周杰伦', signal: 4, reason: '两次完整播放', provenance: 'implicit' },
        { kind: 'track', key: '晴天|周杰伦', signal: 4, reason: '两次完整播放', provenance: 'implicit' },
      ],
      { now: Date.now(), halfLifeDays: 90 },
    )
    await store.upsertTrackRef({ trackKey: '晴天|周杰伦', title: '晴天', artist: '周杰伦', music: MUSIC, played: true, resolved: true })

    const out = await byName('music_profile').execute({ view: 'digest' }, {})
    expect(String(out.summary)).toContain('周杰伦')
    const tracks = out.tracks as Array<{ title: string; source: string; id: string }>
    expect(tracks).toHaveLength(1)
    expect(tracks[0]?.source).toBe('wy')
    expect(tracks[0]?.id).toBe('wy_186016')
    expect(String(out.note)).toContain('music_play_song')
  })

  it('没有可直取引用的曲目不给候选（避免又退化成搜索）', async () => {
    const { byName, store } = makeHarness()
    await store.applyDeltas([{ kind: 'track', key: '某某|某人', signal: 3, reason: '播放', provenance: 'implicit' }], { now: Date.now(), halfLifeDays: 90 })
    const out = await byName('music_profile').execute({ view: 'tracks' }, {})
    expect(out.tracks).toHaveLength(0)
  })

  it('空画像给出友好引导，而不是编造口味', async () => {
    const { byName } = makeHarness()
    const out = await byName('music_profile').execute({ view: 'digest' }, {})
    expect(String(out.summary)).toContain('还没有')
    expect(out.artists).toHaveLength(0)
  })

  it('for-mood 用"情绪×艺人"关联；没有该情境记录时退回总体口味', async () => {
    const { byName, store } = makeHarness()
    await store.applyDeltas(
      [
        { kind: 'artist', key: '草东没有派对', signal: 3, reason: '完整播放', provenance: 'implicit' },
        { kind: 'tag', key: 'mood:frustrated@artist:草东没有派对', signal: 3, reason: '完整播放（情境 frustrated）', provenance: 'implicit' },
      ],
      { now: Date.now(), halfLifeDays: 90 },
    )
    const hit = await byName('music_profile').execute({ view: 'for-mood', mood: 'frustrated' }, {})
    expect(String(hit.summary)).toContain('frustrated')
    expect(String(hit.summary)).toContain('草东没有派对')

    const miss = await byName('music_profile').execute({ view: 'for-mood', mood: 'happy' }, {})
    expect(String(miss.summary)).toContain('还没有')
  })

  it('预算档位 minimal 会压缩候选数且不带理由', async () => {
    const { byName, store } = makeHarness({ memory: { budget: 'minimal' } })
    for (let i = 0; i < 6; i++) {
      await store.applyDeltas([{ kind: 'artist', key: `艺人${i}`, signal: 5 - i * 0.1, reason: '播放', provenance: 'implicit' }], { now: Date.now(), halfLifeDays: 90 })
    }
    const out = await byName('music_profile').execute({ view: 'artists' }, {})
    const artists = out.artists as Array<{ reason: string }>
    expect(artists.length).toBeLessThanOrEqual(3)
    expect(artists.every((a) => a.reason === '')).toBe(true)
  })

  it('画像被关闭时不报错，明确告知已关闭', async () => {
    const { byName } = makeHarness({ memory: { enabled: false } })
    const out = await byName('music_profile').execute({ view: 'digest' }, {})
    expect(String(out.summary)).toContain('已关闭')
    expect(out.artists).toHaveLength(0)
  })
})

describe('music_play_song：Tier-1 画像直取', () => {
  it('命中已确认引用时**零搜索**播放', async () => {
    const { byName, store, service } = makeHarness()
    await store.upsertTrackRef({ trackKey: '晴天|周杰伦', title: '晴天', artist: '周杰伦', music: MUSIC, played: true, resolved: true })
    // 证明"没有发生搜索"：一旦调用 search 就抛错
    service.search = async () => {
      throw new Error('Tier-1 不应该发生搜索')
    }
    const out = await byName('music_play_song').execute({ source: 'wy', id: 'wy_186016' }, {})
    expect(out.via).toBe('profile')
    expect(out.played).toBe(true)
    expect(out.title).toBe('晴天')
    expect(service.getState().current?.id).toBe('wy_186016')
  })

  it('画像里没有该 id 时明确报错并指路（不猜测、不搜索）', async () => {
    const { byName } = makeHarness()
    await expect(byName('music_play_song').execute({ source: 'wy', id: '不存在' }, {})).rejects.toThrow(/画像里没有/)
  })

  it('直取时解析失败要带上原因抛出，不静默换歌', async () => {
    const { byName, store, service } = makeHarness()
    await store.upsertTrackRef({ trackKey: '晴天|周杰伦', title: '晴天', artist: '周杰伦', music: MUSIC, played: true, resolved: true })
    service.resolveUrl = async () => {
      throw new Error('音源脚本超时')
    }
    await expect(byName('music_play_song').execute({ source: 'wy', id: 'wy_186016' }, {})).rejects.toThrow(/直取播放失败.*音源脚本超时/)
  })
})

describe('music_play_song：Tier-2 精确确认', () => {
  it('曲名+艺人精确匹配后播放，并把确认结果写回画像', async () => {
    const { byName, store } = makeHarness()
    const out = await byName('music_play_song').execute({ title: '晴天', artist: '周杰伦' }, {})
    expect(out.via).toBe('match')
    expect(out.variant).toBe('original')
    expect(out.title).toBe('晴天')
    expect(out.artist).toBe('周杰伦')
    // 写回画像：下次就能走 Tier-1
    const ref = store.findByRef(String(out.source), String(out.id))
    expect(ref).toBeDefined()
    expect(ref?.record.status).toBe('seen') // 还没听完 → 只算"确认过"
  })

  it('显式指定版本是硬要求：要 Live 时不会拿原唱顶替', async () => {
    const { byName } = makeHarness()
    await expect(byName('music_play_song').execute({ title: '晴天', artist: '周杰伦', variant: 'live' }, {})).rejects.toThrow(/没有与/)
  })

  it('艺人不对时明确失败，并列出未通过校验的候选', async () => {
    const { byName } = makeHarness()
    await expect(byName('music_play_song').execute({ title: '晴天', artist: '林俊杰' }, {})).rejects.toThrow(/没有与|未找到/)
  })

  it('缺 title 也缺 id 时报错', async () => {
    const { byName } = makeHarness()
    await expect(byName('music_play_song').execute({}, {})).rejects.toThrow(/需要提供/)
  })

  it('画像关闭时拒绝精确点播并指向 music_play', async () => {
    const { byName } = makeHarness({ memory: { enabled: false } })
    await expect(byName('music_play_song').execute({ title: '晴天', artist: '周杰伦' }, {})).rejects.toThrow(/画像已关闭/)
  })

  it('可以顺带合并记录显式喜好（省一整轮往返）', async () => {
    const { byName, store } = makeHarness()
    await byName('music_play_song').execute({ title: '晴天', artist: '周杰伦', prefer_like: ['金玟岐'] }, {})
    const entity = store.top('artist', { now: Date.now(), halfLifeDays: 90, limit: 10 }).find((a) => a.key === String('金玟岐'))
    expect(entity?.explicit).toBe(3)
    // 事件流里也要有这条（否则无法解释"为什么画像里突然多了金玟岐"）
    const events = store.readEvents({ retainDays: 90 })
    expect(events.some((e) => e.kind === 'like')).toBe(true)
  })
})

describe('music_taste', () => {
  it('like → 显式权重 +3（不衰减），并写事件', async () => {
    const { byName, store } = makeHarness()
    const out = await byName('music_taste').execute({ action: 'like', entity: '金玟岐' }, {})
    expect(out.ok).toBe(true)
    expect(String(out.summary)).toContain('喜欢')
    expect(store.top('artist', { now: Date.now(), halfLifeDays: 90 })[0]?.explicit).toBe(3)
  })

  it('dislike → −3，并且不会因为"没听过"而被隐式分抵消', async () => {
    const { byName, store } = makeHarness()
    await byName('music_taste').execute({ action: 'dislike', entity: '某流量歌手' }, {})
    const entity = store.top('artist', { now: Date.now(), halfLifeDays: 90, includeNegative: true })[0]
    expect(entity?.explicit).toBe(-3)
  })

  it('forget → 画像忘掉该对象（不可逆但只影响画像）', async () => {
    const { byName, store } = makeHarness()
    await byName('music_taste').execute({ action: 'like', entity: '金玟岐' }, {})
    const removed = await byName('music_taste').execute({ action: 'forget', entity: '金玟岐' }, {})
    expect(removed.ok).toBe(true)
    expect(store.load('artist')['金玟岐']).toBeUndefined()

    const again = await byName('music_taste').execute({ action: 'forget', entity: '金玟岐' }, {})
    expect(again.ok).toBe(false)
  })

  it('summary 给出可读口味摘要与证据', async () => {
    const { byName, store } = makeHarness()
    await store.applyDeltas([{ kind: 'artist', key: '周杰伦', signal: 6, reason: '播放', provenance: 'implicit' }], { now: Date.now(), halfLifeDays: 90 })
    const out = await byName('music_taste').execute({ action: 'summary' }, {})
    expect(String(out.summary)).toContain('周杰伦')
    expect((out.items as string[]).join()).toContain('置信度')
  })

  it('note → 记一条自然语言备注', async () => {
    const { byName, store } = makeHarness()
    const out = await byName('music_taste').execute({ action: 'note', note: '加班时想听安静的女声' }, {})
    expect(out.ok).toBe(true)
    expect(store.readState().summary).toContain('加班')
  })

  it('缺 entity 时报错；画像关闭时返回 ok=false 而不是抛错', async () => {
    const { byName } = makeHarness()
    await expect(byName('music_taste').execute({ action: 'like' }, {})).rejects.toThrow(/需要提供 entity/)

    const disabled = makeHarness({ memory: { enabled: false } })
    const out = await disabled.byName('music_taste').execute({ action: 'like', entity: '某某' }, {})
    expect(out.ok).toBe(false)
    expect(String(out.summary)).toContain('已关闭')
  })
})
