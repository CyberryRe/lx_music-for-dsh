// 内置引擎测试：音源脚本沙箱（加载/调用/超时/错误）、引擎调度（脚本轮询/降级）、
// 音源管理（上传/启停/删除/排序/校验）、SDK 结果规范化、本地存储。

import { describe, expect, it } from './mini'
import { loadSourceScript, extractScriptMetadata, SourceScriptError } from '../src/engine/sandbox'
import { EngineProvider } from '../src/engine/musicEngine'
import { DomainSourceStore, MemorySourceStore } from '../src/engine/sourceStore'
import { sdkItemToMusicInfo } from '../src/sdk'
import type { MusicInfo } from '../src/shared/types'

const SAMPLE_SCRIPT = `/**
 * @name 测试音源
 * @version 1.0.0
 * @author dsh
 */
lx.on('request', async ({ action, source, info }) => {
  if (action === 'musicUrl') {
    return 'https://example.com/' + source + '/' + info.quality + '.mp3'
  }
  throw new Error('unknown action: ' + action)
})
lx.send('inited', { sources: { wy: { name: '测试', type: 'music' }, kg: {} } })`

function song(overrides: Partial<MusicInfo> = {}): MusicInfo {
  return {
    id: 'wy_1',
    name: '晴天',
    singer: '周杰伦',
    source: 'wy',
    interval: '04:29',
    meta: { songId: '1', albumName: '叶惠美', qualitys: [{ type: '128k', size: '3.6M' }, { type: '320k', size: '9.2M' }] },
    ...overrides,
  }
}

function memStorageFace() {
  const tables = new Map<string, Map<string, unknown>>()
  return {
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

describe('loadSourceScript 沙箱', () => {
  it('加载成功并注册平台', async () => {
    const loaded = await loadSourceScript('test.js', SAMPLE_SCRIPT)
    expect(loaded.name).toBe('测试音源')
    expect(Object.keys(loaded.sources).sort()).toEqual(['kg', 'wy'])
    loaded.dispose()
  })

  it('musicUrl 调用返回直链（含 songInfo 标准化字段）', async () => {
    const loaded = await loadSourceScript('test.js', SAMPLE_SCRIPT)
    const url = await loaded.call('musicUrl', 'wy', { musicInfo: song(), quality: '320k', type: '320k' })
    expect(url).toBe('https://example.com/wy/320k.mp3')
    loaded.dispose()
  })

  it('未调用 lx.send("inited") 时初始化超时', async () => {
    await expect(loadSourceScript('bad.js', 'var x = 1;')).rejects.toMatchObject({ stage: 'init' })
  })

  it('脚本语法错误抛出 init 错误', async () => {
    await expect(loadSourceScript('bad.js', 'function {')).rejects.toMatchObject({ stage: 'init' })
  })

  it('request 处理器未注册时调用报错', async () => {
    const loaded = await loadSourceScript('noop.js', `lx.send('inited', { sources: { wy: {} } })`)
    await expect(loaded.call('musicUrl', 'wy', {})).rejects.toMatchObject({ stage: 'call' })
    loaded.dispose()
  })

  it('脚本内 throw 的错误传递出来（含脚本名）', async () => {
    const script = `lx.on('request', () => { throw new Error('boom') })
lx.send('inited', { sources: { wy: {} } })`
    const loaded = await loadSourceScript('fail.js', script)
    await expect(loaded.call('musicUrl', 'wy', {})).rejects.toThrow('boom')
    loaded.dispose()
  })

  it('extractScriptMetadata 解析 @name/@version/@author', () => {
    const meta = extractScriptMetadata(SAMPLE_SCRIPT)
    expect(meta.name).toBe('测试音源')
    expect(meta.version).toBe('1.0.0')
    expect(meta.author).toBe('dsh')
  })

  it('沙箱提供 lx.utils.crypto.md5 与 Buffer', async () => {
    const script = `lx.on('request', ({ action }) => {
  if (action === 'ping') return lx.utils.crypto.md5('abc') + '|' + lx.utils.buffer.from('hi', 'utf8').toString()
})
lx.send('inited', { sources: { wy: {} } })`
    const loaded = await loadSourceScript('util.js', script)
    const result = (await loaded.call('ping', 'wy', {})) as string
    expect(result.startsWith('900150983cd24fb0d6963f7d28e17f72')).toBe(true)
    expect(result.endsWith('|hi')).toBe(true)
    loaded.dispose()
  })

  it('SourceScriptError 带 stage 标记', () => {
    const err = new SourceScriptError('call', 'x')
    expect(err.stage).toBe('call')
    expect(err).toBeInstanceOf(Error)
  })
})

describe('EngineProvider 音源管理', () => {
  it('upload → list → resolveUrl 全流程（导入后自动启用）', async () => {
    const engine = new EngineProvider({ storage: memStorageFace() })
    const up = await engine.uploadSource('my-source.js', SAMPLE_SCRIPT)
    expect(up.success).toBe(true)
    expect(up.id).toBe('测试音源.js')

    const list = await engine.listSources()
    expect(list).toHaveLength(1)
    expect(list[0]?.enabled).toBe(true)
    expect(list[0]?.status).toBe('success')

    const result = await engine.resolveUrl(song(), '320k')
    expect(result.url).toBe('https://example.com/wy/320k.mp3')
    expect(result.type).toBe('320k')
    expect(result.sourceName).toBe('测试音源')
  })

  it('无音源脚本时 resolveUrl 抛友好错误', async () => {
    const engine = new EngineProvider({ storage: memStorageFace() })
    await expect(engine.resolveUrl(song(), '320k')).rejects.toThrow(/未找到支持 wy 平台/)
  })

  it('多脚本轮询：第一个失败自动尝试下一个', async () => {
    const failScript = `lx.on('request', () => { throw new Error('解析失败') })
lx.send('inited', { sources: { wy: {} } })`
    const engine = new EngineProvider({ storage: memStorageFace() })
    await engine.uploadSource('fail.js', failScript)
    await engine.uploadSource('ok.js', SAMPLE_SCRIPT)
    const result = await engine.resolveUrl(song(), '128k')
    expect(result.url).toBe('https://example.com/wy/128k.mp3')
    expect(result.sourceName).toBe('测试音源')
  })

  it('toggle 禁用后不再用于解析；重新启用恢复', async () => {
    const engine = new EngineProvider({ storage: memStorageFace() })
    await engine.uploadSource('ok.js', SAMPLE_SCRIPT)
    const off = await engine.toggleSource('测试音源.js', false)
    expect(off.success).toBe(true)
    await expect(engine.resolveUrl(song(), '320k')).rejects.toThrow(/未找到支持 wy 平台/)
    await engine.toggleSource('测试音源.js', true)
    const result = await engine.resolveUrl(song(), '320k')
    expect(result.url).toMatch(/^https:\/\//)
  })

  it('validateSource：合法脚本通过并列出平台；非法脚本失败', async () => {
    const engine = new EngineProvider({ storage: memStorageFace() })
    const ok = (await engine.validateSource(SAMPLE_SCRIPT)) as { valid: boolean; sources?: string[] }
    expect(ok.valid).toBe(true)
    expect(ok.sources?.sort()).toEqual(['kg', 'wy'])
    const bad = (await engine.validateSource('var x = 1')) as { valid: boolean; error?: string }
    expect(bad.valid).toBe(false)
  })

  it('delete 删除脚本后无法解析', async () => {
    const engine = new EngineProvider({ storage: memStorageFace() })
    await engine.uploadSource('ok.js', SAMPLE_SCRIPT)
    const del = await engine.deleteSource('测试音源.js')
    expect(del.success).toBe(true)
    expect(await engine.listSources()).toHaveLength(0)
    await expect(engine.resolveUrl(song(), '320k')).rejects.toThrow(/未找到支持 wy 平台/)
  })

  it('reorder 影响解析优先级（顺序在前者优先成功）', async () => {
    const firstScript = `lx.on('request', () => 'https://first.example.com/a.mp3')
lx.send('inited', { sources: { wy: {} } })`
    const engine = new EngineProvider({ storage: memStorageFace() })
    await engine.uploadSource('first.js', firstScript)
    await engine.uploadSource('second.js', SAMPLE_SCRIPT)
    const r1 = await engine.resolveUrl(song(), '320k')
    expect(r1.url).toBe('https://first.example.com/a.mp3')
    await engine.reorderSources(['测试音源.js', 'first.js'])
    const r2 = await engine.resolveUrl(song(), '320k')
    expect(r2.url).toBe('https://example.com/wy/320k.mp3')
  })

  it('uploadSource 脚本加载失败时返回错误（不保存坏脚本）', async () => {
    const engine = new EngineProvider({ storage: memStorageFace() })
    const r = await engine.uploadSource('bad.js', 'not a script at all')
    expect(r.success).toBe(false)
    expect(await engine.listSources()).toHaveLength(0)
  })
})

describe('sourceStore 持久化', () => {
  it('DomainSourceStore 写入后可重新装载', async () => {
    const storage = memStorageFace()
    const store1 = new DomainSourceStore(storage as never)
    await store1.put({
      id: 'a.js', name: 'A', script: '//x', enabled: true, createdAt: 't', updatedAt: 't',
    })
    await store1.setOrder(['a.js'])

    const store2 = new DomainSourceStore(storage as never)
    expect(store2.list()).toHaveLength(1)
    expect(store2.list()[0]?.name).toBe('A')
    expect(store2.order()).toEqual(['a.js'])
  })

  it('MemorySourceStore 基本 CRUD', async () => {
    const store = new MemorySourceStore()
    await store.put({ id: 'a', name: 'A', script: '//', enabled: true, createdAt: 't', updatedAt: 't' })
    await store.put({ id: 'b', name: 'B', script: '//', enabled: true, createdAt: 't', updatedAt: 't' })
    expect(store.order()).toEqual(['a', 'b'])
    await store.setOrder(['b', 'a'])
    expect(store.order()).toEqual(['b', 'a'])
    await store.remove('a')
    expect(store.list()).toHaveLength(1)
  })
})

describe('SDK 结果规范化', () => {
  it('sdkItemToMusicInfo 转换旧版结构为插件 MusicInfo', () => {
    const item = {
      singer: '周杰伦',
      name: '晴天',
      albumName: '叶惠美',
      albumId: 123,
      source: 'wy',
      interval: '04:29',
      songmid: 456,
      img: 'https://picsum.photos/1',
      types: [
        { type: '128k', size: '3.6M' },
        { type: '320k', size: '9.2M' },
      ],
    }
    const music = sdkItemToMusicInfo(item as never)
    expect(music.id).toBe('wy_456')
    expect(music.meta.songId).toBe(456)
    expect(music.meta.picUrl).toBe('https://picsum.photos/1')
    expect(music.meta.qualitys?.map((q) => q.type)).toEqual(['128k', '320k'])
    expect(music.interval).toBe('04:29')
  })
})
