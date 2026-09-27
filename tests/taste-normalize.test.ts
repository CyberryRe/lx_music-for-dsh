// 归一化与版本识别测试。
//
// 样例全部来自**真实抓取**的五平台搜索结果（docs/design-taste-memory.md §2 spike #5）：
// 搜"晴天 周杰伦"时网易云前 5 条里有 4 条是翻唱/女声/DJ 版，其中
// `晴天 (原唱 周杰伦) - RyaVocal` 就是当初把用户点播变成翻唱的那一条。
// 这些用例的作用是把它钉死：严格匹配**必须拒绝**它。

import { describe, expect, it } from './mini'
import {
  DEFAULT_DURATION_TOLERANCE_SEC,
  detectVariant,
  normalizeArtist,
  normalizeText,
  normalizeTitle,
  pickBestMatch,
  secondsFromInterval,
  strictMatch,
  toHalfWidth,
  trackKey,
} from '../src/taste/normalize'

// ---- 真实候选（spike #5 原样抄录）----
const TX_ORIGINAL = { name: '晴天', singer: '周杰伦', interval: '04:29', albumName: '叶惠美' }
const TX_LIVE_1 = { name: '晴天 (Live)', singer: '周杰伦', interval: '04:09', albumName: '周杰伦地表最强世界巡回演唱会' }
const TX_LIVE_2 = { name: '晴天 (Live)', singer: '周杰伦', interval: '04:59', albumName: '周杰伦 2004 无与伦比 演唱会 Live CD' }
const WY_COVER_RYAVOCAL = { name: '晴天 (原唱 周杰伦)', singer: 'RyaVocal', interval: '04:30', albumName: '晴天' }
const WY_COVER_LUCKY = { name: '晴天(深情版)', singer: 'Lucky小爱', interval: '04:38', albumName: '晴天(深情版)' }
const WY_FEMALE = { name: '晴天 (女声版))', singer: 'GYBeat', interval: '04:28', albumName: '晴天 (女声版)' }
const MG_ORIGINAL = { name: '晴天', singer: '周杰伦', interval: '04:30', albumName: '叶惠美' }
const MG_UNRELATED = { name: '圣诞星（feat. 杨瑞代）', singer: '周杰伦', interval: '03:02', albumName: '圣诞星' }

describe('基础归一化', () => {
  it('全角转半角（含全角空格）', () => {
    expect(toHalfWidth('ＡＢＣ　１２３')).toBe('ABC 123')
  })

  it('去空白/标点/大小写', () => {
    expect(normalizeText(' Jay   Chow! ')).toBe('jaychow')
    expect(normalizeText('晴天。')).toBe('晴天')
  })

  it('曲名剥掉括号里的版本后缀', () => {
    expect(normalizeTitle('晴天 (Live)')).toBe('晴天')
    expect(normalizeTitle('晴天（女声版）')).toBe('晴天')
    expect(normalizeTitle('晴天 (伴奏)')).toBe('晴天')
    expect(normalizeTitle('圣诞星（feat. 杨瑞代）')).toBe('圣诞星')
    expect(normalizeTitle('稻香 (Remaster)')).toBe('稻香')
  })

  it('不误伤正常曲名', () => {
    expect(normalizeTitle('一路向北')).toBe('一路向北')
    expect(normalizeTitle('像晴天像雨天')).toBe('像晴天像雨天')
    expect(normalizeTitle('以父之名')).toBe('以父之名')
  })

  it('艺人取主歌手（合唱/feat. 只算第一个）', () => {
    expect(normalizeArtist('周杰伦 / 杨瑞代')).toBe('周杰伦')
    expect(normalizeArtist('周杰伦、杨瑞代')).toBe('周杰伦')
    expect(normalizeArtist('汪苏泷 feat. 某某')).toBe('汪苏泷')
    expect(normalizeArtist('Jay')).toBe('jay')
  })

  it('曲目 key = 归一化曲名|归一化艺人（Live 版与原唱同 key，靠 variant 区分）', () => {
    expect(trackKey('晴天', '周杰伦')).toBe(trackKey('晴天 (Live)', '周杰伦'))
    expect(trackKey('晴天', '周杰伦')).not.toBe(trackKey('晴天', 'RyaVocal'))
  })
})

describe('时长解析', () => {
  it('mm:ss 与 h:mm:ss', () => {
    expect(secondsFromInterval('04:29')).toBe(269)
    expect(secondsFromInterval('1:02:03')).toBe(3723)
    expect(secondsFromInterval('00:30')).toBe(30)
  })

  it('无法解析返回 undefined（不抛错、不产生 NaN）', () => {
    expect(secondsFromInterval(undefined)).toBeUndefined()
    expect(secondsFromInterval('')).toBeUndefined()
    expect(secondsFromInterval('abc')).toBeUndefined()
    expect(secondsFromInterval('4:99:99')).toBe(4 * 3600 + 99 * 60 + 99)
  })
})

describe('版本识别（用真实数据）', () => {
  it('原唱', () => {
    expect(detectVariant(TX_ORIGINAL)).toBe('original')
    expect(detectVariant(MG_ORIGINAL)).toBe('original')
  })

  it('Live：曲名带 (Live) 或专辑是演唱会', () => {
    expect(detectVariant(TX_LIVE_1)).toBe('live')
    expect(detectVariant(TX_LIVE_2)).toBe('live')
    expect(detectVariant({ name: '晴天', albumName: '周杰伦地表最强世界巡回演唱会' })).toBe('live')
  })

  it('翻唱/变体：RyaVocal 那条被识别为 cover，而不是原唱', () => {
    expect(detectVariant(WY_COVER_RYAVOCAL)).toBe('cover')
  })

  it('伴奏/纯音乐与 remix 单独归类', () => {
    expect(detectVariant({ name: '晴天 (伴奏)' })).toBe('instrumental')
    expect(detectVariant({ name: '晴天 (DJ版)' })).toBe('remix')
  })
})

describe('严格匹配（Tier-2 的核心规则）', () => {
  it('原唱完全匹配：曲名+艺人+时长都对 → 通过且得分最高', () => {
    const out = strictMatch({ title: '晴天', artist: '周杰伦', album: '叶惠美', durationSec: 269 }, TX_ORIGINAL)
    expect(out.ok).toBe(true)
    expect(out.variant).toBe('original')
    expect(out.score).toBeGreaterThan(6)
  })

  it('**拒绝翻唱**：RyaVocal 的"晴天 (原唱 周杰伦)" 不能冒充原唱（当初的真实事故）', () => {
    const out = strictMatch({ title: '晴天', artist: '周杰伦' }, WY_COVER_RYAVOCAL)
    expect(out.ok).toBe(false)
    expect(out.reasons.join()).toContain('艺人')
  })

  it('**拒绝时长不符的 Live 版**：点名 04:29 的原唱时，04:09 的 Live 不通过', () => {
    const out = strictMatch({ title: '晴天', artist: '周杰伦', durationSec: 269 }, TX_LIVE_1)
    expect(out.ok).toBe(false)
    expect(out.reasons.join()).toContain('时长')
  })

  it('未给时长时 Live 版可以通过，但得分低于原唱（版本优先级起作用）', () => {
    const request = { title: '晴天', artist: '周杰伦' }
    const original = strictMatch(request, TX_ORIGINAL)
    const live = strictMatch(request, TX_LIVE_1)
    expect(live.ok).toBe(true)
    expect(live.variant).toBe('live')
    expect(live.score).toBeLessThan(original.score)
  })

  it('时长容差可配（±5s 默认；放宽后 04:30 与 04:29 都算吻合）', () => {
    expect(DEFAULT_DURATION_TOLERANCE_SEC).toBe(5)
    expect(strictMatch({ title: '晴天', artist: '周杰伦', durationSec: 269 }, MG_ORIGINAL).ok).toBe(true)
    expect(strictMatch({ title: '晴天', artist: '周杰伦', durationSec: 269 }, MG_ORIGINAL, { durationToleranceSec: 0 }).ok).toBe(false)
  })

  it('歌名不同直接拒绝（咪咕会混进无关结果）', () => {
    expect(strictMatch({ title: '晴天', artist: '周杰伦' }, MG_UNRELATED).ok).toBe(false)
  })

  it('只给歌名不给艺人时，靠版本与时长判断；女声版不会被当原唱', () => {
    const request = { title: '晴天' }
    expect(strictMatch(request, WY_FEMALE).variant).toBe('cover')
    expect(strictMatch(request, TX_ORIGINAL).variant).toBe('original')
  })

  it('显式指定版本时按指定版本判定', () => {
    const live = strictMatch({ title: '晴天', artist: '周杰伦', variant: 'live' }, TX_LIVE_1)
    expect(live.ok).toBe(true)
    expect(live.variant).toBe('live')
    expect(live.reasons.join()).not.toContain('版本不符')
    expect(live.score).toBeGreaterThan(0)
  })
})

describe('pickBestMatch：绝不退化成"取第 0 个"', () => {
  const wyResults = [WY_COVER_LUCKY, WY_COVER_RYAVOCAL, WY_FEMALE] // 真实顺序：前几条全是翻唱

  it('候选里混着翻唱时，挑出真正的原唱', () => {
    const best = pickBestMatch({ title: '晴天', artist: '周杰伦' }, [TX_LIVE_1, WY_COVER_RYAVOCAL, TX_ORIGINAL, WY_FEMALE])
    expect(best?.candidate).toEqual(TX_ORIGINAL)
    expect(best?.outcome.variant).toBe('original')
  })

  it('网易云那批结果里没有原唱 → 返回 undefined（上层必须明确失败，而不是放翻唱）', () => {
    const best = pickBestMatch({ title: '晴天', artist: '周杰伦' }, wyResults)
    expect(best).toBeUndefined()
  })

  it('多平台同一原唱时结果稳定（时长/专辑吻合者优先）', () => {
    const best = pickBestMatch({ title: '晴天', artist: '周杰伦', album: '叶惠美', durationSec: 269 }, [TX_ORIGINAL, MG_ORIGINAL])
    expect(best?.candidate).toEqual(TX_ORIGINAL)
  })

  it('空候选 → undefined', () => {
    expect(pickBestMatch({ title: '晴天' }, [])).toBeUndefined()
  })
})
