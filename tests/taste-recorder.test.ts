// 录制器测试：会话生命周期、何时结算、seen/played 升级、探索折扣、来源归因（ALS）、
// 以及"录制失败绝不影响播放"这条硬约束。
//
// 还包含一条**贯通测试**：PlaybackService 的钩子是否真的按预期触发（暂停恢复不重开会话、
// 切歌结算上一首、上报到末尾算完整播放）——这些是接线正确性的锁。

import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { PlaybackService } from '../src/playback'
import { DEFAULT_SETTINGS } from '../src/shared/types'
import type { StorageFace } from '../src/playback'
import type { MusicInfo } from '../src/shared/types'
import { SlidingWindowRateLimiter } from '../src/ratelimit'
import { TasteRecorder } from '../src/taste/recorder'
import { TasteStore } from '../src/taste/store'
import { runWithPlayContext } from '../src/taste/origin'
import { trackKey as makeKey } from '../src/taste/normalize'

const T0 = Date.UTC(2026, 0, 15, 12, 0, 0)

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

const music = (name: string, singer: string, source: MusicInfo['source'] = 'tx', interval = '04:29'): MusicInfo => ({
  id: `${source}_${name}`,
  name,
  singer,
  source,
  interval,
  meta: { songId: `${name}-id`, albumName: '叶惠美' },
})

/** 等待 fire-and-forget 的录制任务落盘（recorder 内部是异步写，但不改变播放结果）。 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setImmediate(r))
}

function makeRecorder(): { recorder: TasteRecorder; storage: ReturnType<typeof fakeStorage>; warnings: string[] } {
  const storage = fakeStorage()
  const warnings: string[] = []
  const store = new TasteStore(storage, { now: () => T0, onWarn: (m) => warnings.push(m) })
  const recorder = new TasteRecorder({ store, now: () => T0, halfLifeDays: 90, exploreRatio: 0.2, onWarn: (m) => warnings.push(m) })
  return { recorder, storage, warnings }
}

/** 取艺人实体的原始计数（比净分数更能表达"有没有记成负反馈"）。 */
const artistEntity = (storage: ReturnType<typeof fakeStorage>, key: string): { implicit: number; plays: number; skips: number } =>
  (storage.raw.get('taste_artists')?.get(key) as { implicit: number; plays: number; skips: number } | undefined) ?? {
    implicit: 0,
    plays: 0,
    skips: 0,
  }

const artistScore = (storage: ReturnType<typeof fakeStorage>, key: string): number => artistEntity(storage, key).implicit

const trackStatus = (storage: ReturnType<typeof fakeStorage>, key: string): string | undefined =>
  (storage.raw.get('taste_tracks')?.get(key) as { status?: string } | undefined)?.status

describe('录制器：会话与结算', () => {
  it('完整播放 → 曲目与艺人各 +2，并升为 played', async () => {
    const { recorder, storage } = makeRecorder()
    const key = makeKey('晴天', '周杰伦')
    recorder.notePlay(music('晴天', '周杰伦'))
    await settle()
    // 开始播放只说明"这首歌在某平台可播" → seen；确认听完才升级为 played
    expect(trackStatus(storage, key)).toBe('seen')

    recorder.noteProgress(269, 269, 'playing')
    await settle()
    expect(artistScore(storage, '周杰伦')).toBeCloseTo(2, 3)
    expect(trackStatus(storage, key)).toBe('played')
  })

  it('切歌按已播比例结算：只听了 5% 就是切走（用户点的 −1.5）', async () => {
    const { recorder, storage } = makeRecorder()
    recorder.notePlay(music('晴天', '周杰伦'))
    recorder.noteProgress(13, 269, 'playing') // ≈4.8%
    recorder.notePlay(music('稻香', '周杰伦')) // 切歌 → 结算上一首
    await settle()
    // 晴天 −1.5、稻香 还没结算；艺人维度两次都记：−1.5（切走）
    expect(artistScore(storage, '周杰伦')).toBeCloseTo(-1.5, 3)
  })

  it('AI 放的歌被切走 → 艺人只 −0.3（归因打折），策略维度另有记录', async () => {
    const { recorder, storage } = makeRecorder()
    runWithPlayContext({ origin: 'ai', context: 'frustrated' }, () => {
      recorder.notePlay(music('晴天', '周杰伦'))
      recorder.noteProgress(5, 269, 'playing')
      recorder.notePlay(music('稻香', '周杰伦'))
    })
    await settle()
    expect(artistScore(storage, '周杰伦')).toBeCloseTo(-0.3, 3)
    const strategy = storage.raw.get('taste_tags')?.get('strategy:frustrated') as { implicit: number } | undefined
    expect(strategy?.implicit).toBeCloseTo(-0.5, 3)
  })

  it('探索曲被切走：负反馈再乘 0.25（反向茧房防护）', async () => {
    const { recorder, storage } = makeRecorder()
    runWithPlayContext({ origin: 'ai', mode: 'explore' }, () => {
      recorder.notePlay(music('新歌', '新人'))
      recorder.noteProgress(3, 200, 'playing')
      recorder.notePlay(music('别的歌', '别人'))
    })
    await settle()
    expect(artistScore(storage, '新人')).toBeCloseTo(-0.075, 3) // -0.3 × 0.25
  })

  it('同一首在 single 模式下重播：不结算、只记 repeats，最终额外 +1.5', async () => {
    const { recorder, storage } = makeRecorder()
    recorder.notePlay(music('晴天', '周杰伦'))
    recorder.noteProgress(100, 269, 'playing')
    recorder.notePlay(music('晴天', '周杰伦')) // 单曲循环：同一首再次开始
    expect(recorder.activeSession()?.repeats).toBe(1)
    recorder.noteProgress(269, 269, 'playing')
    await settle()
    // 完整播放 +2 与重播 +1.5 都记上
    expect(artistScore(storage, '周杰伦')).toBeCloseTo(3.5, 3)
  })

  it('顺序播放到列表末尾（noteFinished）按完整播放结算', async () => {
    const { recorder, storage } = makeRecorder()
    recorder.notePlay(music('晴天', '周杰伦'))
    recorder.noteProgress(60, 269, 'playing')
    recorder.noteFinished()
    await settle()
    expect(artistScore(storage, '周杰伦')).toBeCloseTo(2, 3)
    expect(trackStatus(storage, '晴天|周杰伦')).toBe('played')
  })

  it('播放出错（status=error）不记任何偏好，会话被丢弃', async () => {
    const { recorder, storage } = makeRecorder()
    recorder.notePlay(music('晴天', '周杰伦'))
    recorder.noteProgress(0, 269, 'error')
    expect(recorder.activeSession()).toBeNull()
    recorder.notePlay(music('稻香', '周杰伦'))
    await settle()
    expect(artistScore(storage, '周杰伦')).toBe(0) // 晴天的"失败"没有变成负反馈
  })

  it('flush：卸载时把当前会话按已播比例结算（不丢证据）', async () => {
    const { recorder, storage } = makeRecorder()
    recorder.notePlay(music('晴天', '周杰伦'))
    recorder.noteProgress(269, 269, 'playing')
    recorder.flush()
    await settle()
    expect(artistScore(storage, '周杰伦')).toBeCloseTo(2, 3)
  })
})

describe('录制器：seen / played 与探索池', () => {
  it('只确认身份（探索点开但马上切走）不算"听过"', async () => {
    const { recorder, storage } = makeRecorder()
    runWithPlayContext({ origin: 'ai', mode: 'explore' }, () => {
      recorder.notePlay(music('没听过的歌', '新艺人'))
      recorder.noteProgress(2, 200, 'playing')
      recorder.notePlay(music('下一首', '别人'))
    })
    await settle()
    expect(trackStatus(storage, '没听过的歌|新艺人')).toBe('seen')
    const store = new TasteStore(storage, { now: () => T0 })
    expect(store.hasPlayed('没听过的歌|新艺人')).toBe(false)
    expect(store.playedKeys().size).toBe(0)
  })

  it('听过一段（≥30%）就算 played，进入"已听"池', async () => {
    const { recorder, storage } = makeRecorder()
    recorder.notePlay(music('听了一半', '艺人A'))
    recorder.noteProgress(150, 269, 'playing') // ≈56%
    recorder.notePlay(music('下一首', '艺人B'))
    await settle()
    expect(trackStatus(storage, makeKey('听了一半', '艺人A'))).toBe('played')
  })

  it('移除/清空：只听了一点点就当没听过（清理列表 ≠ 不喜欢）', async () => {
    const { recorder, storage } = makeRecorder()
    recorder.notePlay(music('晴天', '周杰伦'))
    recorder.noteProgress(3, 269, 'playing')
    recorder.noteRemoved()
    await settle()
    expect(artistScore(storage, '周杰伦')).toBe(0)
  })

  it('移除时已经听了一半 → 按正常结算记录', async () => {
    const { recorder, storage } = makeRecorder()
    recorder.notePlay(music('晴天', '周杰伦'))
    recorder.noteProgress(200, 269, 'playing')
    recorder.noteRemoved()
    await settle()
    expect(artistScore(storage, '周杰伦')).toBeCloseTo(0.5, 3) // 部分播放
  })
})

describe('录制器：意图信号与来源归因', () => {
  it('加入列表：排队 +0.2；用户明确点歌额外 +1.0', async () => {
    const { recorder, storage } = makeRecorder()
    recorder.noteIntent([music('晴天', '周杰伦')])
    await settle()
    expect(artistScore(storage, '周杰伦')).toBeCloseTo(1, 3) // 用户点歌的意图分
    const track = storage.raw.get('taste_tracks')?.get('晴天|周杰伦') as { implicit: number } | undefined
    expect(track?.implicit).toBeCloseTo(1.2, 3) // 排队 +0.2 与意图 +1.0
  })

  it('AI 加歌只记排队分，不给意图分（不把 AI 的选择当用户意愿）', async () => {
    const { recorder, storage } = makeRecorder()
    runWithPlayContext({ origin: 'ai' }, () => recorder.noteIntent([music('晴天', '周杰伦')]))
    await settle()
    expect(artistScore(storage, '周杰伦')).toBe(0)
    const track = storage.raw.get('taste_tracks')?.get('晴天|周杰伦') as { implicit: number } | undefined
    expect(track?.implicit).toBeCloseTo(0.2, 3)
  })

  it('探索模式下开始播放会把曲目标上 lastExploredAt（去重窗口要用）', async () => {
    const { recorder, storage } = makeRecorder()
    runWithPlayContext({ origin: 'ai', mode: 'explore' }, () => recorder.notePlay(music('新歌', '新人')))
    recorder.noteProgress(1, 200, 'playing')
    recorder.notePlay(music('别的', '别人'))
    await settle()
    const record = storage.raw.get('taste_tracks')?.get('新歌|新人') as { lastExploredAt?: number } | undefined
    expect(record?.lastExploredAt).toBe(T0)
  })

  it('探索统计分开计数（分组评估与自适应探索率的基础）', async () => {
    const { recorder, storage } = makeRecorder()
    // 一次探索失败（用 flush 收尾，避免把下一次切歌也算进探索）
    runWithPlayContext({ origin: 'ai', mode: 'explore' }, () => {
      recorder.notePlay(music('新歌', '新人'))
      recorder.noteProgress(1, 200, 'playing')
      recorder.flush()
    })
    // 一次复听完整播放
    recorder.notePlay(music('晴天', '周杰伦'))
    recorder.noteProgress(269, 269, 'playing')
    await settle()
    const state = storage.raw.get('taste_state')?.get('summary') as { exploreStats?: Record<string, number> } | undefined
    expect(state?.exploreStats?.exploreSkips).toBe(1)
    expect(state?.exploreStats?.replayPlays).toBe(1)
    expect(state?.exploreStats?.explorePlays).toBe(0)
  })
})

describe('录制器：故障隔离', () => {
  it('存储抛错只告警，不冒泡（画像坏了不能影响放歌）', async () => {
    const storage = fakeStorage()
    const warnings: string[] = []
    storage.table = () => ({
      get: () => undefined,
      put: async () => {
        throw new Error('disk full')
      },
      entries: () => new Map<string, unknown>().entries(),
      delete: async () => false,
    })
    const store = new TasteStore(storage, { now: () => T0, onWarn: (m) => warnings.push(m) })
    const recorder = new TasteRecorder({ store, now: () => T0, onWarn: (m) => warnings.push(m) })

    recorder.notePlay(music('晴天', '周杰伦'))
    recorder.noteProgress(269, 269, 'playing')
    await settle()
    expect(warnings.length).toBeGreaterThan(0)
  })
})

describe('接线：PlaybackService 钩子', () => {
  const makeService = (): { service: PlaybackService; recorder: TasteRecorder; storage: ReturnType<typeof fakeStorage> } => {
    const storage = fakeStorage()
    const store = new TasteStore(storage, { now: () => T0 })
    const recorder = new TasteRecorder({ store, now: () => T0 })
    const service = new PlaybackService(new Context(), {
      storage,
      settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' },
      rateLimiter: new SlidingWindowRateLimiter({ maxCalls: 6, windowMs: 60_000 }),
      taste: recorder,
    })
    return { service, recorder, storage }
  }

  it('addMusic + play 会开会话，报进度到末尾则结算为完整播放', async () => {
    const { service, recorder, storage } = makeService()
    const song = music('晴天', '周杰伦')
    service.addMusic([song], 'tail')
    expect(recorder.activeSession()).toBeNull() // addMusic 只记意图，不开会话
    service.play({ index: 0 })
    expect(recorder.activeSession()?.trackKey).toBe(makeKey('晴天', '周杰伦'))

    service.reportProgress({ progress: 269, duration: 269, status: 'playing' })
    await settle()
    // 完整播放 +2，加上 addMusic 的"用户明确点歌"意图 +1 = 3
    expect(artistScore(storage, '周杰伦')).toBeCloseTo(3, 3)
    expect(artistEntity(storage, '周杰伦').plays).toBe(1)
    expect(artistEntity(storage, '周杰伦').skips).toBe(0)
  })

  it('pause 后 resume（play 不带 index）不重开会话、不清零进度', () => {
    const { service, recorder } = makeService()
    service.addMusic([music('晴天', '周杰伦')], 'tail')
    service.play({ index: 0 })
    service.reportProgress({ progress: 100, duration: 269, status: 'playing' })
    service.pause()
    service.play({})
    expect(recorder.activeSession()?.maxProgressSec).toBe(100)
    expect(recorder.activeSession()?.repeats).toBe(0)
  })

  it('next() 会结算上一首（按已播比例：秒切记负反馈）', async () => {
    const { service, storage } = makeService()
    service.addMusic([music('晴天', '周杰伦')], 'tail')
    service.addMusic([music('稻香', '周杰伦')], 'tail')
    service.play({ index: 0 })
    service.reportProgress({ progress: 10, duration: 269, status: 'playing' })
    service.next()
    await settle()
    const entity = artistEntity(storage, '周杰伦')
    // 意图分：两首都是"用户明确点歌" → +1.0 ×2；晴天 3.7% 被切走 → −1.5
    expect(entity.skips).toBe(1)
    expect(entity.plays).toBe(0)
    expect(entity.implicit).toBeCloseTo(0.5, 3)
  })

  it('播到一半再切歌 → 记部分播放（不是秒切）', async () => {
    const { service, storage } = makeService()
    service.addMusic([music('晴天', '周杰伦'), music('稻香', '周杰伦')], 'tail')
    service.play({ index: 0 })
    service.reportProgress({ progress: 200, duration: 269, status: 'playing' }) // 74%
    service.next()
    await settle()
    const entity = artistEntity(storage, '周杰伦')
    expect(entity.skips).toBe(0)
    expect(entity.plays).toBe(1)
    // 部分播放 +0.5；意图 +1.0 ×2
    expect(entity.implicit).toBeCloseTo(2.5, 3)
  })

  it('removeMusic 移除正在播的那首：只听过一点则不记负反馈', async () => {
    const { service, storage } = makeService()
    const song = music('晴天', '周杰伦')
    service.addMusic([song], 'tail')
    service.play({ index: 0 })
    service.reportProgress({ progress: 5, duration: 269, status: 'playing' })
    service.removeMusic(song.id)
    await settle()
    const entity = artistEntity(storage, '周杰伦')
    expect(entity.skips).toBe(0) // 清理列表不该被算成"不喜欢"
    expect(entity.plays).toBe(0)
    expect(entity.implicit).toBeCloseTo(1, 3) // 只剩"用户明确点歌"的意图分
  })

  it('不传 taste 钩子时一切照常（画像可选）', () => {
    const service = new PlaybackService(new Context(), {
      settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' },
    })
    service.addMusic([music('晴天', '周杰伦')], 'tail')
    expect(service.play({ index: 0 }).status).toBe('playing')
    service.reportProgress({ progress: 10, duration: 269, status: 'playing' })
  })
})
