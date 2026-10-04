// 歌词解析（src/shared/lrc.ts）单测：时间标签、offset、翻译对齐、逐字时间轴、纯文本兜底。
// 这些规则直接决定"滚动歌词是否对得上"，因此按真实平台返回的形态构造输入。

import { describe, expect, it } from './mini'
import { findLyricLineIndex, findLyricWordIndex, parseLrcTimeLabel, parseLyric } from '../src/shared/lrc'

describe('parseLrcTimeLabel', () => {
  it('支持 mm:ss.xxx / hh:mm:ss / mm:ss / 纯秒', () => {
    expect(parseLrcTimeLabel('00:12.34')).toBeCloseTo(12.34, 3)
    expect(parseLrcTimeLabel('01:02:03.5')).toBeCloseTo(3723.5, 3)
    expect(parseLrcTimeLabel('03:05')).toBeCloseTo(185, 3)
    expect(parseLrcTimeLabel('42')).toBeCloseTo(42, 3)
  })

  it('脏标签返回 null（整行丢弃而不是算出 NaN 时间）', () => {
    expect(parseLrcTimeLabel('ab:cd')).toBeNull()
    expect(parseLrcTimeLabel('')).toBeNull()
    expect(parseLrcTimeLabel('1:2:3:4')).toBeNull()
    expect(parseLrcTimeLabel('-1:00')).toBeNull()
  })
})

describe('parseLyric', () => {
  const lrc = ['[ti:测试]', '[ar:某人]', '[offset:0]', '[00:01.00]第一行', '[00:05.50]第二行', '[00:10.00]第三行'].join('\n')

  it('解析时间标签、跳过元数据行、按时间升序', () => {
    const doc = parseLyric({ lyric: lrc }, { source: 'sdk', format: 'lrc' })
    expect(doc.lines).toHaveLength(3)
    expect(doc.lines[0]?.time).toBeCloseTo(1, 3)
    expect(doc.lines[0]?.text).toBe('第一行')
    expect(doc.lines[1]?.time).toBeCloseTo(5.5, 3)
    expect(doc.source).toBe('sdk')
    expect(doc.format).toBe('lrc')
    expect(doc.plain).toBe(false)
  })

  it('一行多个时间标签 → 多行（副歌复用同一句）', () => {
    const doc = parseLyric({ lyric: '[00:01.00][00:09.00]副歌\n[00:05.00]主歌' }, { source: 'sdk' })
    expect(doc.lines).toHaveLength(3)
    expect(doc.lines.map((l) => l.time)).toEqual([1, 5, 9])
    expect(doc.lines[2]?.text).toBe('副歌')
  })

  it('行时长 = 到下一行的时间差（末行有兜底）', () => {
    const doc = parseLyric({ lyric: lrc }, { source: 'sdk' })
    expect(doc.lines[0]?.duration).toBeCloseTo(4.5, 2)
    expect(doc.lines[2]?.duration).toBeGreaterThan(0)
  })

  it('[offset:] 正数让歌词提前（时间变小）并写入 doc.offset', () => {
    const doc = parseLyric({ lyric: '[offset:500]\n[00:10.00]词' }, { source: 'sdk' })
    expect(doc.offset).toBe(500)
    expect(doc.lines[0]?.time).toBeCloseTo(9.5, 3)
  })

  it('负 offset 让歌词延后（时间变大）', () => {
    const doc = parseLyric({ lyric: '[offset:-5000]\n[00:01.00]词' }, { source: 'sdk' })
    expect(doc.lines[0]?.time).toBeCloseTo(6, 3)
  })

  it('正 offset 大到把行推到 0 之前时 clamp 为 0', () => {
    const doc = parseLyric({ lyric: '[offset:5000]\n[00:01.00]词' }, { source: 'sdk' })
    expect(doc.lines[0]?.time).toBe(0)
  })

  it('翻译按最近时间对齐（±300ms 容差）', () => {
    const doc = parseLyric(
      { lyric: '[00:01.00]hello\n[00:05.00]world', tlyric: '[00:01.20]你好\n[00:05.10]世界' },
      { source: 'sdk' },
    )
    expect(doc.hasTranslation).toBe(true)
    expect(doc.lines[0]?.tr).toBe('你好')
    expect(doc.lines[1]?.tr).toBe('世界')
  })

  it('没有独立翻译时，同一时间戳的第二行按翻译合并', () => {
    const doc = parseLyric({ lyric: '[00:01.00]hello\n[00:01.00]你好\n[00:05.00]world' }, { source: 'sdk', platform: 'kw' })
    expect(doc.lines).toHaveLength(2)
    expect(doc.lines[0]?.tr).toBe('你好')
    expect(doc.lines[0]?.text).toBe('hello')
  })

  it('逐字时间轴来自 lxlyric，并保留行文本', () => {
    const doc = parseLyric(
      {
        lyric: '[00:01.00]hello world',
        lxlyric: '[00:01.00]<0,500>hello <500,500>world',
      },
      { source: 'sdk', platform: 'wy', format: 'lxlyric' },
    )
    expect(doc.hasWordTiming).toBe(true)
    expect(doc.lines[0]?.text).toBe('hello world')
    expect(doc.lines[0]?.words).toHaveLength(2)
    expect(doc.lines[0]?.words?.[1]?.time).toBe(500)
    expect(doc.lines[0]?.words?.[1]?.duration).toBe(500)
  })

  it('主歌词里内嵌的逐字标签会被剥离（不显示尖括号）', () => {
    const doc = parseLyric({ lyric: '[00:01.00]<0,200>你<200,300>好' }, { source: 'sdk', platform: 'kg' })
    expect(doc.lines[0]?.text).toBe('你好')
    expect(doc.lines[0]?.text.includes('<')).toBe(false)
  })

  it('只有纯文本（无时间标签）时补出伪时间轴，并标记 plain', () => {
    const doc = parseLyric({ lyric: '第一句\n第二句\n第三句' }, { source: 'sdk', platform: 'mg' })
    expect(doc.plain).toBe(true)
    expect(doc.lines).toHaveLength(3)
    expect(doc.lines[0]?.time).toBe(0)
    expect(doc.lines[1]?.time).toBeCloseTo(3, 3)
  })

  it('已知曲目时长时伪时间轴铺满全曲', () => {
    const doc = parseLyric({ lyric: 'a\nb\nc' }, { source: 'sdk', platform: 'mg', duration: 120 })
    expect(doc.lines[1]!.time).toBeGreaterThan(3)
    expect(doc.lines[2]!.time).toBeLessThan(120)
  })

  it('空 payload → 空 lines + note（不抛错）', () => {
    const doc = parseLyric({}, { source: 'sdk' })
    expect(doc.lines).toHaveLength(0)
    expect(doc.format).toBe('none')
    expect(typeof doc.note).toBe('string')
  })

  it('乱序输入会排序', () => {
    const doc = parseLyric({ lyric: '[00:05.00]b\n[00:01.00]a' }, { source: 'sdk' })
    expect(doc.lines.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('逐字时间明显越界时整行丢弃逐字轴（脏数据的防线），但保留行文本', () => {
    const doc = parseLyric(
      { lyric: '[00:00.00]ab\n[00:02.00]cd', lxlyric: '[00:00.00]<0,99999>a<99999,1>b' },
      { source: 'sdk', platform: 'kw' },
    )
    // 宁可没有卡拉OK高亮，也不能让高亮跳到别的字上
    expect(doc.lines[0]?.words).toBeUndefined()
    expect(doc.lines[0]?.text).toBe('ab')
  })

  it('逐字时间在行内时保留，并按行时长截断时长', () => {
    const doc = parseLyric(
      { lyric: '[00:00.00]ab\n[00:02.00]cd', lxlyric: '[00:00.00]<0,500>a<1500,2000>b' },
      { source: 'sdk', platform: 'kw' },
    )
    const words = doc.lines[0]?.words ?? []
    expect(words.length).toBe(2)
    expect(words[0]?.time).toBe(0)
    expect(words[1]?.time).toBe(1500)
    // 行时长 2s：词时长被截到不超过行时长
    expect(words[1]?.duration).toBeLessThanOrEqual(2000)
  })

  it('酷我真实形态：每行第一个词就是 <a,-a> 归一化后的 <0,450>，不能丢字', () => {
    // 原始 lxrc（实测 rid 228908 晴天，[kuwo:127] → offset 8/offset2 7）：
    //   [00:02.250]<3150,-3150>词<6750,450>：<10350,4050>周…
    // 平台模块会把它归一化成下面这种 <起点,时长>；早期版本把"第二个数为负"的标签当行级标记
    // 删掉，导致当前行渲染 words 时**每行第一个字消失**（UI 只渲染 words）。
    const doc = parseLyric(
      {
        lyric: '[00:02.25]词：周杰伦',
        lxlyric: '[00:02.25]<0,450>词<450,450>：<900,450>周<1350,4050>杰<5400,450>伦',
      },
      { source: 'sdk', platform: 'kw', format: 'lxlyric' },
    )
    const line = doc.lines[0]!
    expect(line.words?.length).toBe(5)
    expect(line.words?.[0]?.text).toBe('词')
    expect(line.words?.[0]?.time).toBe(0)
    // 逐字片段必须拼回整行文本（LyricsWindow 也会用这个等式做兜底）
    expect(line.words!.map((w) => w.text).join('')).toBe(line.text)
  })

  it('一行翻译只归属一行歌词（容差窗口是闭区间，间奏/气声相邻行很常见）', () => {
    const doc = parseLyric(
      { lyric: '[00:10.00]A\n[00:10.20]B', tlyric: '[00:10.10]T' },
      { source: 'sdk' },
    )
    const withTr = doc.lines.filter((l) => l.tr !== undefined)
    expect(withTr.length).toBe(1)
    expect(withTr[0]?.tr).toBe('T')
  })
})

describe('当前行/当前字查找', () => {
  const doc = parseLyric(
    { lyric: '[00:01.00]a\n[00:05.00]b\n[00:09.00]c', lxlyric: '[00:05.00]<0,1000>b<1000,2000>b2' },
    { source: 'sdk' },
  )

  it('findLyricLineIndex：首行之前 -1，之后命中最后一行', () => {
    expect(findLyricLineIndex(doc.lines, 0)).toBe(-1)
    expect(findLyricLineIndex(doc.lines, 1.1)).toBe(0)
    expect(findLyricLineIndex(doc.lines, 5.2)).toBe(1)
    expect(findLyricLineIndex(doc.lines, 1000)).toBe(2)
  })

  it('findLyricLineIndex：leadIn 让高亮略微提前', () => {
    expect(findLyricLineIndex(doc.lines, 4.85, 0.2)).toBe(1)
    expect(findLyricLineIndex(doc.lines, 4.85, 0)).toBe(0)
  })

  it('findLyricWordIndex：按行内相对时间命中', () => {
    const words = doc.lines[1]?.words
    expect(findLyricWordIndex(words, -1)).toBe(-1)
    expect(findLyricWordIndex(words, 0)).toBe(0)
    expect(findLyricWordIndex(words, 1.5)).toBe(1)
    expect(findLyricWordIndex(undefined, 1)).toBe(-1)
  })
})
