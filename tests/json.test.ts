// jsonSafe 清洗测试：递归删除 undefined 字段，保证 Typert gateway 边界校验通过。

import { describe, expect, it } from './mini'
import { jsonSafe } from '../src/shared/json'

describe('jsonSafe', () => {
  it('删除嵌套 undefined 属性值', () => {
    const input = {
      a: 1,
      b: undefined,
      c: { d: 'x', e: undefined, f: null },
      g: [1, undefined, { h: undefined, i: 2 }],
    }
    const out = jsonSafe(input)
    expect('b' in out).toBe(false)
    expect('e' in (out.c as Record<string, unknown>)).toBe(false)
    expect((out.c as Record<string, unknown>).f).toBeNull()
    expect((out.g as unknown[]).length).toBe(2)
    expect((out.g as Array<Record<string, unknown>>)[1]?.i).toBe(2)
  })

  it('保留 null、数组空值语义，标量原样', () => {
    expect(jsonSafe(null)).toBeNull()
    expect(jsonSafe(0)).toBe(0)
    expect(jsonSafe('x')).toBe('x')
    expect(jsonSafe([1, null, 2])).toEqual([1, null, 2])
  })

  it('MusicInfo 形态（SDK 歌曲）清洗后无 undefined 字段', () => {
    const music = {
      id: 'wy_1',
      name: '晴天',
      singer: '周杰伦',
      source: 'wy',
      interval: '04:29',
      meta: {
        songId: 1,
        albumName: '叶惠美',
        albumId: undefined,
        picUrl: null,
        qualitys: [{ type: '320k', size: '9.2M' }],
        hash: undefined,
        copyrightId: undefined,
        strMediaMid: undefined,
      },
    }
    const out = jsonSafe(music)
    expect('hash' in (out.meta as Record<string, unknown>)).toBe(false)
    expect('albumId' in (out.meta as Record<string, unknown>)).toBe(false)
    expect((out.meta as Record<string, unknown>).picUrl).toBeNull()
    expect((out.meta as Record<string, unknown>).qualitys).toHaveLength(1)
  })
})
