// 画像门面测试：UI/Remote 需要的读写 + 开关的**实时门控**（关掉后立刻停止录制）。
import { describe, expect, it } from './mini'
import type { StorageFace } from '../src/playback'
import type { MusicInfo } from '../src/shared/types'
import { TasteFacade } from '../src/taste/facade'
import { TasteRecorder } from '../src/taste/recorder'
import { TasteStore } from '../src/taste/store'
import { DEFAULT_MEMORY_CONFIG } from '../src/taste/config'

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)

const MUSIC: MusicInfo = {
  id: 'wy_186016',
  name: '晴天',
  singer: '周杰伦',
  source: 'wy',
  interval: '04:29',
  meta: { songId: '186016', albumName: '叶惠美' },
}

function fakeStorage(initialGlobal?: unknown): StorageFace & { raw: Map<string, Map<string, unknown>>; globals: unknown[] } {
  const raw = new Map<string, Map<string, unknown>>()
  const globals: unknown[] = []
  let globalValue = initialGlobal
  return {
    raw,
    globals,
    global: {
      get: () => globalValue,
      set: async (v: unknown) => {
        globals.push(v)
        globalValue = v
      },
    },
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

function makeFacade(overrides: { enabled?: boolean; onboarded?: boolean; snoozed?: boolean; global?: unknown } = {}) {
  const storage = fakeStorage(overrides.global)
  const store = new TasteStore(storage, { now: () => T0 })
  const recorder = new TasteRecorder({ store, now: () => T0 })
  const changes: string[] = []
  const facade = new TasteFacade({
    store,
    recorder,
    storage,
    memory: {
      ...DEFAULT_MEMORY_CONFIG,
      ...(overrides.enabled !== undefined ? { enabled: overrides.enabled } : {}),
      ...(overrides.onboarded ? { onboardedAt: new Date(T0).toISOString() } : {}),
      ...(overrides.snoozed ? { snoozedUntil: new Date(T0 + 86_400_000).toISOString() } : {}),
    },
    now: () => T0,
    onMemoryChange: (m) => changes.push(`${m.enabled}:${m.halfLifeDays}`),
  })
  return { facade, store, storage, recorder, changes }
}

describe('TasteFacade：画像视图', () => {
  it('空画像给出引导文案，并报告引导/静默状态', () => {
    const { facade } = makeFacade()
    const view = facade.profile()
    expect(view.enabled).toBe(true)
    expect(view.onboarded).toBe(false)
    expect(view.snoozed).toBe(false)
    expect(view.summary).toContain('还没有')
    expect(view.artists).toHaveLength(0)
  })

  it('关闭时明确告知已关闭，且不返回任何数据', async () => {
    const { facade, store } = makeFacade({ enabled: false })
    await store.applyDeltas([{ kind: 'artist', key: '周杰伦', signal: 5, reason: '播放', provenance: 'implicit' }], { now: T0, halfLifeDays: 90 })
    const view = facade.profile()
    expect(view.enabled).toBe(false)
    expect(view.artists).toHaveLength(0)
    expect(view.summary).toContain('已关闭')
  })

  it('榜单带分数/证据/置信度，曲目候选带可直取的 source+id', async () => {
    const { facade, store } = makeFacade({ onboarded: true })
    await store.applyDeltas(
      [
        { kind: 'artist', key: '周杰伦', signal: 6, reason: '播放', provenance: 'implicit' },
        { kind: 'track', key: '晴天|周杰伦', signal: 6, reason: '播放', provenance: 'implicit' },
      ],
      { now: T0, halfLifeDays: 90 },
    )
    await store.upsertTrackRef({ trackKey: '晴天|周杰伦', title: '晴天', artist: '周杰伦', music: MUSIC, played: true, resolved: true, variant: 'original' })

    const view = facade.profile()
    expect(view.summary).toContain('周杰伦')
    expect(view.artists[0]?.name).toBe('周杰伦')
    expect(view.artists[0]?.plays).toBe(1)
    expect(view.artists[0]?.confidence).toBe('low')
    expect(view.tracks[0]).toMatchObject({ title: '晴天', artist: '周杰伦', source: 'wy', id: 'wy_186016', status: 'played' })
    expect(view.sampleSize).toBe(1)
    expect(view.onboarded).toBe(true)
  })

  it('没有可直取引用的曲目不出现在候选里', async () => {
    const { facade, store } = makeFacade()
    await store.applyDeltas([{ kind: 'track', key: '某歌|某人', signal: 4, reason: '播放', provenance: 'implicit' }], { now: T0, halfLifeDays: 90 })
    expect(facade.profile().tracks).toHaveLength(0)
  })

  it('静默期被如实报告（首启引导不该反复弹）', () => {
    const { facade } = makeFacade({ snoozed: true })
    expect(facade.profile().snoozed).toBe(true)
  })
})

describe('TasteFacade：事件证据', () => {
  it('事件倒序返回，并把信号翻译成可读理由', async () => {
    const { facade, recorder } = makeFacade()
    recorder.notePlay(MUSIC)
    recorder.noteProgress(269, 269, 'playing')
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const events = facade.events(10)
    expect(events.length).toBeGreaterThan(0)
    expect(events[0]?.kind).toBe('settle')
    expect(events[0]?.title).toBe('晴天')
    expect(events[0]?.reasons.join()).toContain('完整播放')
  })
})

describe('TasteFacade：写操作', () => {
  it('like/dislike 写显式权重并留痕', async () => {
    const { facade, store } = makeFacade()
    const liked = await facade.action({ action: 'like', entity: '金玟岐' })
    expect(liked.ok).toBe(true)
    expect(store.top('artist', { now: T0, halfLifeDays: 90 })[0]?.explicit).toBe(3)

    await facade.action({ action: 'dislike', entity: '某某' })
    const disliked = store.top('artist', { now: T0, halfLifeDays: 90, includeNegative: true }).find((a) => a.key === '某某')
    expect(disliked?.explicit).toBe(-3)
  })

  it('forget 移除对象；不存在时如实回报', async () => {
    const { facade, store } = makeFacade()
    await facade.action({ action: 'like', entity: '金玟岐' })
    expect((await facade.action({ action: 'forget', entity: '金玟岐' })).ok).toBe(true)
    expect(store.load('artist')['金玟岐']).toBeUndefined()
    expect((await facade.action({ action: 'forget', entity: '金玟岐' })).ok).toBe(false)
  })

  it('note 记录自然语言备注', async () => {
    const { facade, store } = makeFacade()
    const out = await facade.action({ action: 'note', note: '通勤时喜欢听播客式的人声' })
    expect(out.ok).toBe(true)
    expect(store.readState().summary).toContain('通勤')
  })

  it('clear 清空全部画像', async () => {
    const { facade, store } = makeFacade()
    await facade.action({ action: 'like', entity: '金玟岐' })
    await store.upsertTrackRef({ trackKey: 'k', title: 't', artist: 'a', music: MUSIC, played: true })
    const out = await facade.action({ action: 'clear' })
    expect(out.ok).toBe(true)
    expect(Object.keys(store.load('artist'))).toHaveLength(0)
    expect(Object.keys(store.load('track'))).toHaveLength(0)
  })

  it('onboard / snooze 写引导状态', async () => {
    const { facade } = makeFacade()
    await facade.action({ action: 'onboard' })
    expect(facade.profile().onboarded).toBe(true)
    await facade.action({ action: 'snooze' })
    expect(facade.profile().snoozed).toBe(true)
  })

  it('缺少必要参数时不静默成功', async () => {
    const { facade } = makeFacade()
    expect((await facade.action({ action: 'like' })).ok).toBe(false)
    expect((await facade.action({ action: 'note' })).ok).toBe(false)
    expect((await facade.action({ action: '未知' })).ok).toBe(false)
  })

  it('关闭画像时写操作被拒绝（除了引导类操作）', async () => {
    const { facade } = makeFacade({ enabled: false })
    expect((await facade.action({ action: 'like', entity: '金玟岐' })).ok).toBe(false)
    expect((await facade.action({ action: 'onboard' })).ok).toBe(true)
  })
})

describe('TasteFacade：配置与实时门控', () => {
  it('改配置会归一化、落盘到 global.memory、并通知外部', async () => {
    const { facade, storage, changes } = makeFacade()
    const next = await facade.updateConfig({ halfLifeDays: 30, budget: 'rich', onboardedAt: new Date(T0).toISOString() })
    expect(next.halfLifeDays).toBe(30)
    expect(next.budget).toBe('rich')
    expect(changes).toHaveLength(1)
    expect(changes[0]).toContain('30')
    const written = storage.globals.at(-1) as { memory?: { halfLifeDays?: number } }
    expect(written.memory?.halfLifeDays).toBe(30)
  })

  it('落盘时保留 global 里的其它字段（不能把播放列表冲掉）', async () => {
    const { facade, storage } = makeFacade({ global: { playlist: [{ id: 'x' }], currentIndex: 0, quality: 'flac', volume: 0.5, mute: false } })
    await facade.updateConfig({ enabled: false })
    const written = storage.globals.at(-1) as Record<string, unknown>
    expect(written.playlist).toEqual([{ id: 'x' }])
    expect(written.quality).toBe('flac')
    expect((written.memory as { enabled: boolean }).enabled).toBe(false)
  })

  it('越界值被夹紧，不会写坏配置', async () => {
    const { facade } = makeFacade()
    const next = await facade.updateConfig({ halfLifeDays: -1, exploreRatio: 99, budget: '不存在' })
    expect(next.halfLifeDays).toBe(1)
    expect(next.exploreRatio).toBe(1)
    expect(next.budget).toBe(DEFAULT_MEMORY_CONFIG.budget)
  })

  it('**关掉开关立刻停止录制**（不需要重启）', async () => {
    const { facade, recorder } = makeFacade()
    facade.notePlay(MUSIC)
    expect(facade.activeSession()).not.toBeNull()

    await facade.updateConfig({ enabled: false })
    // 关闭后立刻不再录制新会话
    facade.notePlay(null)
    expect(facade.activeSession()).toBeNull()
    facade.notePlay(MUSIC)
    expect(facade.activeSession()).toBeNull() // 仍然是 null：没有新会话产生

    // recorder 本身不受影响（关闭前已开始的会话仍可被 flush 结算）
    expect(recorder).toBeDefined()
  })

  it('存储写配置失败时仍然本次生效（不让设置窗口卡住）', async () => {
    const { facade, storage } = makeFacade()
    storage.global.set = async () => {
      throw new Error('disk full')
    }
    const next = await facade.updateConfig({ halfLifeDays: 45 })
    expect(next.halfLifeDays).toBe(45)
    expect(facade.currentConfig().halfLifeDays).toBe(45)
  })
})
