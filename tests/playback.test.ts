// PlaybackService 测试：播放控制、列表管理、设置持久化、音质选择、直链降级（内存 storage + mock provider）。

import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { PlaybackService, pickQuality } from '../src/playback'
import { SlidingWindowRateLimiter } from '../src/ratelimit'
import type { MusicInfo, PluginSettings } from '../src/shared/types'
import { DEFAULT_SETTINGS } from '../src/shared/types'

function song(overrides: Partial<MusicInfo> = {}): MusicInfo {
  return {
    id: 's1',
    name: '晴天',
    singer: '周杰伦',
    source: 'wy',
    interval: '04:29',
    meta: { songId: 's1', albumName: '叶惠美', qualitys: [{ type: '128k', size: '3.6M' }, { type: '320k', size: '9.2M' }, { type: 'flac', size: '28M' }] },
    ...overrides,
  }
}

function memStorage() {
  const globalStore = new Map<string, unknown>()
  const tables = new Map<string, Map<string, unknown>>()
  return {
    global: {
      get: () => globalStore.get('state'),
      set: async (v: unknown) => {
        globalStore.set('state', v)
      },
    },
    table: (name: string) => {
      if (!tables.has(name)) tables.set(name, new Map())
      const t = tables.get(name)!
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

function makeService(options: { settings?: Partial<PluginSettings> } = {}) {
  const storage = memStorage()
  const rateLimiter = new SlidingWindowRateLimiter({ maxCalls: 6, windowMs: 60_000 })
  const logs: unknown[] = []
  const service = new PlaybackService(new Context(), {
    storage,
    settings: { ...DEFAULT_SETTINGS, providerMode: 'mock', ...options.settings },
    rateLimiter,
    onLog: (e) => logs.push(e),
  })
  return { service, storage, logs }
}

describe('PlaybackService 播放控制', () => {
  it('初始为空列表、stoped 状态', () => {
    const { service } = makeService()
    const s = service.getState()
    expect(s.playlist).toHaveLength(0)
    expect(s.status).toBe('stoped')
    expect(s.currentIndex).toBe(-1)
  })

  it('play(index) 设置当前曲目与 playing 状态', () => {
    const { service } = makeService()
    service.addMusic([song(), song({ id: 's2', name: '七里香', interval: '04:59' })], 'tail')
    const s = service.play({ index: 1 })
    expect(s.currentIndex).toBe(1)
    expect(s.current?.name).toBe('七里香')
    expect(s.status).toBe('playing')
    expect(s.duration).toBe(299) // 04:59
  })

  it('toggle/pause/next/prev/seek 状态流转', () => {
    const { service } = makeService()
    service.addMusic([song(), song({ id: 's2', name: '七里香' }), song({ id: 's3', name: '稻香' })], 'tail')
    service.play({ index: 0 })
    expect(service.toggle().status).toBe('paused')
    expect(service.toggle().status).toBe('playing')
    expect(service.next().currentIndex).toBe(1)
    expect(service.prev().currentIndex).toBe(0)
    // next 循环到末尾后回到 0
    service.play({ index: 2 })
    expect(service.next().currentIndex).toBe(0)
    service.seek(120)
    expect(service.getState().progress).toBe(120)
  })

  it('空列表操作抛错', () => {
    const { service } = makeService()
    expect(() => service.play({})).toThrow('播放列表为空')
    expect(() => service.toggle()).toThrow('播放列表为空')
    expect(() => service.next()).toThrow('播放列表为空')
  })
})

describe('PlaybackService 列表管理', () => {
  it('addMusic tail / next 位置语义', () => {
    const { service } = makeService()
    service.addMusic([song()], 'tail')
    service.addMusic([song({ id: 's2', name: '七里香' })], 'tail')
    service.play({ index: 0 })
    service.addMusic([song({ id: 's3', name: '稻香' })], 'next')
    const s = service.getState()
    expect(s.playlist.map((m) => m.name)).toEqual(['晴天', '稻香', '七里香'])
    expect(s.currentIndex).toBe(0)
  })

  it('removeMusic 修正当前索引', () => {
    const { service } = makeService()
    service.addMusic([song(), song({ id: 's2', name: '七里香' }), song({ id: 's3', name: '稻香' })], 'tail')
    service.play({ index: 2 })
    service.removeMusic('s2')
    expect(service.getState().playlist.map((m) => m.id)).toEqual(['s1', 's3'])
    expect(service.getState().currentIndex).toBe(1)
    // 删除当前曲目
    service.removeMusic('s3')
    expect(service.getState().currentIndex).toBe(0)
    expect(service.getState().current?.id).toBe('s1')
  })

  it('clearList 清空并 stoped', () => {
    const { service } = makeService()
    service.addMusic([song()], 'tail')
    service.play({ index: 0 })
    const s = service.clearList()
    expect(s.playlist).toHaveLength(0)
    expect(s.status).toBe('stoped')
  })

  it('reorderList 拖拽排序并保持当前曲目', () => {
    const { service } = makeService()
    service.addMusic([song({ id: 'a', name: 'A' }), song({ id: 'b', name: 'B' }), song({ id: 'c', name: 'C' })], 'tail')
    service.play({ index: 0 })
    const s = service.reorderList(['c', 'a', 'b'])
    expect(s.playlist.map((m) => m.name)).toEqual(['C', 'A', 'B'])
    expect(s.currentIndex).toBe(1) // A 现在在位置 1
  })

  it('exportList 输出文本', () => {
    const { service } = makeService()
    service.addMusic([song(), song({ id: 's2', name: '七里香' })], 'tail')
    service.play({ index: 1 })
    const text = service.exportList()
    expect(text).toContain('▶')
    expect(text).toContain('晴天 - 周杰伦')
    expect(text).toContain('七里香')
  })
})

describe('PlaybackService 设置与持久化', () => {
  it('saveSettings 生效并回调 onSettingsChange', () => {
    const changed: PluginSettings[] = []
    const svc = new PlaybackService(new Context(), {
      settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' },
      onSettingsChange: (s) => changed.push(s),
    })
    svc.saveSettings({ defaultQuality: 'flac' })
    expect(changed).toHaveLength(1)
    expect(svc.getSettings().defaultQuality).toBe('flac')
  })

  it('持久化：重启后恢复播放列表与设置', async () => {
    const storage = memStorage()
    const first = new PlaybackService(new Context(), {
      storage,
      settings: { ...DEFAULT_SETTINGS, providerMode: 'mock', defaultQuality: '128k' },
    })
    first.addMusic([song()], 'tail')
    first.saveSettings({ defaultQuality: 'flac' })
    await new Promise((r) => setTimeout(r, 400)) // 等 schedulePersist 落盘

    const second = new PlaybackService(new Context(), {
      storage,
      settings: { ...DEFAULT_SETTINGS, providerMode: 'mock', defaultQuality: '128k' },
    })
    const s = second.getState()
    expect(s.playlist).toHaveLength(1)
    expect(s.currentIndex).toBe(0)
    expect(second.getSettings().defaultQuality).toBe('flac') // UI 保存覆盖默认
  })
})

describe('PlaybackService 播放模式（playMode）', () => {
  function seeded() {
    const h = makeService()
    h.service.addMusic([song({ id: 'a', name: 'A' }), song({ id: 'b', name: 'B' }), song({ id: 'c', name: 'C' })], 'tail')
    h.service.play({ index: 0 })
    return h
  }

  it('默认列表循环，setPlayMode 校验并持久化', async () => {
    const { service } = makeService()
    expect(service.getState().playMode).toBe('list')
    service.setPlayMode('shuffle')
    expect(service.getState().playMode).toBe('shuffle')
    expect(() => service.setPlayMode('bogus' as never)).toThrow(/未知播放模式/)
  })

  it('列表循环：next 到末尾回到第一首', () => {
    const { service } = seeded()
    service.play({ index: 2 })
    expect(service.next().currentIndex).toBe(0)
  })

  it('单曲循环：手动 next 同样前进（单曲重播由 client ended 处理）', () => {
    const { service } = seeded()
    service.setPlayMode('single')
    service.play({ index: 1 })
    expect(service.next().currentIndex).toBe(2)
  })

  it('顺序播放：next 到末尾停止（保持当前曲目）', () => {
    const { service } = seeded()
    service.setPlayMode('order')
    service.play({ index: 1 })
    expect(service.next().currentIndex).toBe(2)
    const st = service.next()
    expect(st.currentIndex).toBe(2)
    expect(st.status).toBe('stoped')
    expect(st.progress).toBe(st.duration)
    // 再次 next 仍停在末尾
    expect(service.next().status).toBe('stoped')
  })

  it('顺序播放：prev 到开头后重播第一首', () => {
    const { service } = seeded()
    service.setPlayMode('order')
    service.play({ index: 1 })
    expect(service.prev().currentIndex).toBe(0)
    expect(service.prev().currentIndex).toBe(0)
  })

  it('随机播放：next 不重复当前曲目', () => {
    const { service } = seeded()
    service.setPlayMode('shuffle')
    for (let i = 0; i < 10; i++) {
      const before = service.getState().currentIndex
      const st = service.next()
      expect(st.currentIndex).not.toBe(before)
    }
  })

  it('随机播放：单曲列表时重播当前', () => {
    const { service } = makeService()
    service.addMusic([song()], 'tail')
    service.play({ index: 0 })
    service.setPlayMode('shuffle')
    expect(service.next().currentIndex).toBe(0)
  })

  it('playMode 持久化：重启后恢复', async () => {
    const storage = memStorage()
    const first = new PlaybackService(new Context(), { storage, settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' } })
    first.setPlayMode('order')
    await new Promise((r) => setTimeout(r, 400))
    const second = new PlaybackService(new Context(), { storage, settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' } })
    expect(second.getState().playMode).toBe('order')
  })

  it('旧持久化数据无 playMode 时回退 list', async () => {
    const storage = memStorage()
    // 直接写入旧版本格式数据（无 playMode 字段）
    await storage.global.set({ playlist: [song()], currentIndex: 0, quality: '320k', volume: 1, mute: false })
    const second = new PlaybackService(new Context(), { storage, settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' } })
    expect(second.getState().playMode).toBe('list')
  })
})

describe('pickQuality 音质选择', () => {
  const settings = { ...DEFAULT_SETTINGS, providerMode: 'mock' } as PluginSettings

  it('autoPullHighestOnSwitch 取降级链中最高可用音质', () => {
    const q = pickQuality(song(), settings)
    expect(q).toBe('flac')
  })

  it('关闭自动最高音质时取默认音质', () => {
    const q = pickQuality(song(), { ...settings, autoPullHighestOnSwitch: false })
    expect(q).toBe('320k')
  })

  it('显式音质优先', () => {
    const q = pickQuality(song(), settings, '128k')
    expect(q).toBe('128k')
  })

  it('歌曲不支持任何目标音质时回退', () => {
    const noQuality = song({ meta: { songId: 'x', albumName: '', qualitys: [{ type: 'wav', size: '1M' }] } })
    const q = pickQuality(noQuality, settings)
    expect(['flac', '320k', '128k']).toContain(q)
  })
})

describe('PlaybackService 直链解析（mock provider）', () => {
  it('resolveUrl 成功返回直链（含降级链）', async () => {
    const { service } = makeService()
    const r = await service.resolveUrl({ music: song() })
    expect(r.url).toMatch(/^https?:\/\//)
    expect(r.type).toBe('flac')
  })

  it('resolveUrl 带显式音质', async () => {
    const { service } = makeService()
    const r = await service.resolveUrl({ music: song(), quality: '128k' })
    expect(r.type).toBe('128k')
  })
})

