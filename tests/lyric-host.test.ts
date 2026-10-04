// host 侧歌词链路中**纯函数**部分的单测。
//
// 不测真实网络与音源脚本子进程（测试运行器禁止 spawn，且网络不该进单测）：
// 那两条路径由各自的实机验证覆盖（见 docs/internals.md §5.3）。
// 这里锁的是最容易写错的"字段搬运"：
//   MusicInfo.meta → 平台歌词模块入参（各平台字段名不同）、SDK 条目 → MusicInfo 的歌词直链、
//   音源脚本返回值 → 统一 payload、以及 payload → LyricDoc 的端到端解析。

import { describe, expect, it } from './mini'
import { buildLyricSongInfo, fetchPlatformLyric, scriptLyricToPayload } from '../src/sdk/lyric'
import { sdkItemToMusicInfo } from '../src/sdk/index'
import { parseLyric } from '../src/shared/lrc'
import type { MusicInfo } from '../src/shared/types'

function music(patch: Partial<MusicInfo> = {}, meta: Partial<MusicInfo['meta']> = {}): MusicInfo {
  return {
    id: 'mg_3790007',
    name: '晴天',
    singer: '周杰伦',
    source: 'mg',
    interval: '04:29',
    meta: { songId: '3790007', albumName: '叶惠美', qualitys: [], ...meta },
    ...patch,
  }
}

describe('buildLyricSongInfo：MusicInfo → 各平台歌词模块入参', () => {
  it('把 meta.songId 提升为 songmid，并带上 interval', () => {
    const info = buildLyricSongInfo(music())
    expect(info.songmid).toBe('3790007')
    expect(info.name).toBe('晴天')
    expect(info.interval).toBe('04:29')
  })

  it('搬运 kg 的 hash 与 mg 的三个歌词直链（漏一个咪咕就没歌词）', () => {
    const info = buildLyricSongInfo(music({ source: 'kg' }, {
      hash: 'ABC123',
      lrcUrl: 'https://tyqk.migu.cn/a.lrc',
      mrcUrl: 'https://tyqk.migu.cn/a.mrc',
      trcUrl: 'https://tyqk.migu.cn/a.trc',
      copyrightId: '6009',
    }))
    expect(info.hash).toBe('ABC123')
    expect(info.copyrightId).toBe('6009')
    expect(info.lrcUrl).toBe('https://tyqk.migu.cn/a.lrc')
    expect(info.mrcUrl).toBe('https://tyqk.migu.cn/a.mrc')
    expect(info.trcUrl).toBe('https://tyqk.migu.cn/a.trc')
  })

  it('空字符串/null 的字段不写进入参（避免平台拿到 "undefined" 当 id）', () => {
    const info = buildLyricSongInfo(music({}, { songId: '', hash: '', lrcUrl: undefined }))
    expect(info.songmid).toBeUndefined()
    expect('hash' in info).toBe(false)
    expect('lrcUrl' in info).toBe(false)
  })
})

describe('sdkItemToMusicInfo：搜索结果里的歌词直链不能丢', () => {
  it('mg 搜索条目上的 lrcUrl/mrcUrl/trcUrl 会进入 meta', () => {
    const item = {
      singer: '周杰伦',
      name: '晴天',
      albumName: '叶惠美',
      source: 'mg',
      interval: '04:29',
      songmid: '3790007',
      copyrightId: '6009',
      lrcUrl: 'https://x/a.lrc',
      mrcUrl: 'https://x/a.mrc',
      trcUrl: 'https://x/a.trc',
    }
    const out = sdkItemToMusicInfo(item as never)
    expect(out.meta.lrcUrl).toBe('https://x/a.lrc')
    expect(out.meta.mrcUrl).toBe('https://x/a.mrc')
    expect(out.meta.trcUrl).toBe('https://x/a.trc')
    expect(out.meta.songId).toBe('3790007')
  })

  it('没有直链时不产生 undefined 字段（gateway 边界校验要求）', () => {
    const out = sdkItemToMusicInfo({ singer: 'a', name: 'b', albumName: '', source: 'tx', interval: '03:00', songmid: 'abc' } as never)
    expect('lrcUrl' in out.meta).toBe(false)
  })
})

describe('音源脚本返回值 → payload', () => {
  it('接受字符串（有的脚本直接回 LRC 文本）', () => {
    const payload = scriptLyricToPayload('[00:01.00]词')
    expect(payload?.lyric).toBe('[00:01.00]词')
  })

  it('接受对象并保留翻译/逐字字段', () => {
    const payload = scriptLyricToPayload({ lyric: '[00:01.00]a', tlyric: '[00:01.00]A', lxlyric: '[00:01.00]<0,500>a', format: 'lxlyric' })
    expect(payload?.tlyric).toBe('[00:01.00]A')
    expect(payload?.lxlyric).toBe('[00:01.00]<0,500>a')
    expect(payload?.format).toBe('lxlyric')
  })

  it('空内容一律当作"没拿到"（不能返回空歌词假装成功）', () => {
    expect(scriptLyricToPayload({ lyric: '   ' })).toBeNull()
    expect(scriptLyricToPayload({})).toBeNull()
    expect(scriptLyricToPayload(null)).toBeNull()
    expect(scriptLyricToPayload('')).toBeNull()
  })
})

describe('fetchPlatformLyric 的失败路径', () => {
  it('平台没有内置歌词实现时抛出可读错误（local 不是在线平台）', async () => {
    let message = ''
    try {
      await fetchPlatformLyric(music({ source: 'local' }))
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }
    expect(message).toContain('暂不支持')
  })
})

describe('端到端：payload → LyricDoc', () => {
  it('音源脚本返回的逐字歌词能被解析成带 words 的行', () => {
    const payload = scriptLyricToPayload({
      lyric: '[00:01.00]你好世界',
      lxlyric: '[00:01.00]<0,500>你好<500,500>世界',
      format: 'lxlyric',
    })
    expect(payload).not.toBeNull()
    const doc = parseLyric(payload!, { source: 'script', platform: 'kw', format: 'lxlyric', duration: 180 })
    expect(doc.source).toBe('script')
    expect(doc.platform).toBe('kw')
    expect(doc.hasWordTiming).toBe(true)
    expect(doc.lines[0]?.text).toBe('你好世界')
    expect(doc.lines[0]?.words?.length).toBe(2)
  })
})
