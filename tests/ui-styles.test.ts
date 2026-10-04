// UI 样式约定测试。
//
// 背景（1.2.0 实测发现的一个真实缺陷）：`.lxm-btn` 原本是**固定 26×26 的图标按钮**，
// 整个仓库的约定是"文字按钮必须放进 .lxm-toolbar"（那里有 `width:auto` 覆盖）。
// 「我的口味」窗口里的"清空全部画像数据"是独立放置的文字按钮 → 被挤成**竖排文字**
// 并溢出、与相邻内容交叠。
//
// 修法是从根上改：`.lxm-btn` 改用 `min-width` + `white-space: nowrap`（图标仍是 26px 见方，
// 文字自然撑开），并给文字按钮一个自带按钮框的 `.lxm-btn-text`。
// 本文件锁住这两条约定，避免回归成"依赖父容器才不坏"的脆弱写法。

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from './mini'
import { CSS } from '../src/ui/styles'

/** 取出某个选择器的规则体（精确匹配 `选择器 {`，避免 `.lxm-btn` 命中 `.lxm-btn-text`）。 */
function ruleBody(css: string, selector: string): string | undefined {
  const start = css.indexOf(`${selector} {`)
  if (start < 0) return undefined
  const open = css.indexOf('{', start)
  const close = css.indexOf('}', open)
  return css.slice(open + 1, close)
}

describe('CSS 约定：按钮不能被挤成竖排文字', () => {
  it('.lxm-btn 用 min-width 而不是固定 width，并禁止换行', () => {
    const body = ruleBody(CSS, '.lxm-btn')
    expect(body).toBeDefined()
    const text = body ?? ''
    expect(/min-width:\s*26px/.test(text)).toBe(true)
    // 固定宽度是这次缺陷的根因：文字按钮会先被压到 26px，再把每个字换行
    expect(/(?<!-)width:\s*\d+px/.test(text)).toBe(false)
    expect(text).toContain('white-space: nowrap')
  })

  it('.lxm-btn-text 自带按钮框与自适应宽度（不依赖父容器）', () => {
    const body = ruleBody(CSS, '.lxm-btn-text')
    expect(body).toBeDefined()
    const text = body ?? ''
    expect(/width:\s*auto/.test(text)).toBe(true)
    expect(/padding:/.test(text)).toBe(true)
    expect(/border:/.test(text)).toBe(true)
  })

  it('图标按钮仍然紧凑（min-width 26px 保证可点区域）', () => {
    const body = ruleBody(CSS, '.lxm-btn') ?? ''
    expect(/min-width:\s*26px/.test(body)).toBe(true)
    expect(/height:\s*26px/.test(body)).toBe(true)
  })

  it('.lxm-btn-mode 与 .lxm-toolbar .lxm-btn 仍显式自适应（历史覆盖规则不能丢）', () => {
    expect(/width:\s*auto/.test(ruleBody(CSS, '.lxm-btn-mode') ?? '')).toBe(true)
    expect(CSS).toContain('.lxm-toolbar .lxm-btn')
  })
})

describe('CSS 约定：侧边栏小卡片不能被长文本撑破', () => {
  it('.lxm-card 显式允许被压缩到容器宽度（max-width/min-width/overflow）', () => {
    const body = ruleBody(CSS, '.lxm-card') ?? ''
    // 根因：卡片是侧边栏里的 flex/grid 子项，没有这几条时，一段不带空格的长文本
    // （最典型是报错信息，含 URL/JSON）会把卡片撑出侧边栏、盖住设置入口。
    expect(/max-width:\s*100%/.test(body)).toBe(true)
    expect(/min-width:\s*0/.test(body)).toBe(true)
    expect(/overflow:\s*hidden/.test(body)).toBe(true)
    expect(/box-sizing:\s*border-box/.test(body)).toBe(true)
  })

  it('.lxm-error 换行而不是撑宽（anywhere + 两行截断）', () => {
    const body = ruleBody(CSS, '.lxm-error')
    expect(body).toBeDefined()
    const text = body ?? ''
    expect(/overflow-wrap:\s*anywhere/.test(text)).toBe(true)
    expect(/max-width:\s*100%/.test(text)).toBe(true)
    expect(/overflow:\s*hidden/.test(text)).toBe(true)
    // 两行截断：完整内容靠 title 提示，避免报错把卡片撑高到挤掉控制按钮
    expect(/-webkit-line-clamp:\s*2/.test(text)).toBe(true)
    // 报错不能被单行省略号吞掉（那正是这次的问题：塞在 .lxm-singer 里看不见）
    expect(/white-space:\s*nowrap/.test(text)).toBe(false)
  })

  it('卡片标题链路上的每个祖先都能收缩（省略号才生效）', () => {
    expect(/min-width:\s*0/.test(ruleBody(CSS, '.lxm-card-head') ?? '')).toBe(true)
    expect(/min-width:\s*0/.test(ruleBody(CSS, '.lxm-title') ?? '')).toBe(true)
  })
})

describe('小卡片的报错渲染', () => {
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'Card.tsx'), 'utf8')

  it('报错渲染在独立的 .lxm-error 行里，并带完整内容的 title', () => {
    expect(source).toContain('className="lxm-error"')
    expect(source).toContain('title={errorText}')
  })

  it('不再把原始报错当作 .lxm-singer 的可见文本（会被省略号吞掉）', () => {
    // `.lxm-singer` 里只允许出现简短的「连接失败」占位
    expect(source).not.toContain("(snapshot.error ?? '连接中…')")
    expect(source).toContain("'连接失败'")
  })
})

describe('实验性功能的红色警示（画像默认关闭）', () => {
  it('警示条与确认弹窗用危险色，并且可被压缩（长文案不撑破窗口）', () => {
    for (const selector of ['.lxm-danger', '.lxm-danger-title', '.lxm-modal-card']) {
      const body = ruleBody(CSS, selector)
      expect(body).toBeDefined()
      const text = body ?? ''
      expect(/state-error-primary/.test(text)).toBe(true)
      expect(/max-width:\s*100%/.test(text)).toBe(true)
    }
    // 弹窗是覆盖层：必须有背景遮罩，视觉上真的"弹出"
    expect(CSS).toContain('.lxm-modal-backdrop')
    expect(/position:\s*absolute/.test(ruleBody(CSS, '.lxm-modal-backdrop') ?? '')).toBe(true)
  })

  it('实验性开关在主设置窗口，且开启必须二次确认（全仓库唯一写 enabled:true 的地方）', () => {
    const settings = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'SettingsWindow.tsx'), 'utf8')
    // 开关并入总设置：新增「实验性」标签页
    expect(settings).toContain("'experimental'")
    expect(settings).toContain('实验性')
    expect(settings).toContain('confirmEnable')
    // 确认框里必须有明确的「我已了解」字样（用户确实看到了风险说明）
    expect(settings).toContain('我已了解')
    // 唯一写入点：确认按钮的回调
    const enables = settings.split('\n').filter((line) => /setMemoryConfig\(\{\s*enabled:\s*true/.test(line))
    expect(enables).toHaveLength(1)

    // 口味窗口里不再有开关（它只在已开启时可达）
    const taste = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'TasteWindow.tsx'), 'utf8')
    expect(taste).not.toContain('setMemoryConfig({ enabled: true }')
  })

  it('未开启时不暴露口味入口：卡片 ♪ 按开关渲染，openTaste 直接挡回', () => {
    const card = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'Card.tsx'), 'utf8')
    expect(card).toContain('snapshot.taste?.enabled ?')
    expect(card).toContain('我的口味')
    const store = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'store.ts'), 'utf8')
    // openTaste 首行必须门控（含自动引导路径）
    expect(store).toContain("if (this.snapshot.taste?.enabled !== true) return")
  })
})

// 1.3.0 之后的卡片布局调整（本轮需求）：
//   ① 歌词入口**先隐藏**，但歌词链路（store.openLyrics / LyricsWindow / WindowsHost）必须完整保留；
//   ② 音量从"常驻一行滑块"改成"点喇叭弹出"。
// 这两条都是刻意的产品决策，容易被后来的改动顺手"改回去"，所以在这里钉住。
describe('侧边栏卡片：歌词入口隐藏 + 音量改为点击喇叭弹出', () => {
  const card = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'Card.tsx'), 'utf8')

  it('卡片上不再有歌词按钮（隐藏入口），但歌词逻辑一处不少', () => {
    // 入口没了：不能有「词」按钮，也不能再调起歌词窗口
    expect(card).not.toContain('滚动歌词')
    expect(card).not.toContain('store.openLyrics()')

    // 逻辑保留：store 的歌词 API、歌词窗口、窗口挂载点都还在
    const store = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'store.ts'), 'utf8')
    expect(store).toContain('openLyrics(): void')
    expect(store).toContain('closeLyrics(): void')
    const host = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'WindowsHost.tsx'), 'utf8')
    expect(host).toContain('LxLyricsWindow')
    expect(host).toContain('snapshot.lyricsOpen')
  })

  it('音量滑块不在卡片里常驻，只在 volumeOpen 时渲染', () => {
    // 旧实现是常驻的 .lxm-volume 行（滑杆永远可见）
    expect(card).not.toContain('className="lxm-volume"')
    // 卡片不再自己画面板：交给 VolumePopover（open 受控）
    expect(card).toContain('<VolumePopover')
    expect(card).toMatch(/open=\{volumeOpen\}/)
    expect(card).toContain('setVolumeOpen((v) => !v)')
    // 卡片自己不能再直接写 popover 标记（那意味着面板又回到了卡片里 → 会被裁断）
    expect(card).not.toContain('lxm-volume-pop')
    expect(card).not.toContain('aria-valuetext')
  })

  it('音量交互约定不变：拖动本地预览、抬手提交', () => {
    // 卡片只负责把回调交给 VolumePopover（回调保持稳定引用）
    expect(card).toContain('onPreview={previewVolume}')
    expect(card).toContain('onCommit={commitVolume}')
    const pop = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'VolumePopover.tsx'), 'utf8')
    // 拖动中只 preview、抬手才 commit：本地预览必须来自 input 事件里的 dragging 分支
    expect(pop).toContain('onPreview(valueOf())')
    expect(pop).toContain('onCommit(valueOf())')
    expect(pop).toContain('draggingRef.current')
  })

  it('弹层不能被卡片裁断：手写 DOM portal 到 body + fixed 定位', () => {
    const pop = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'VolumePopover.tsx'), 'utf8')
    // 根因：`.lxm-card` 有 overflow:hidden，留在卡片内的面板必然被裁掉
    expect(pop).toContain('document.body.appendChild(panel)')
    // 手写 portal 必须自己回收（React 不会帮忙）
    expect(pop).toContain('panel.remove()')
    // 也不能依赖 react-dom：本插件只依赖 react（契约是"无新增运行时依赖"）
    expect(pop).not.toContain("from 'react-dom'")
    const body = ruleBody(CSS, '.lxm-volume-pop') ?? ''
    expect(/position:\s*fixed/.test(body)).toBe(true)
    // fixed 元素必须自己保证层级足够高（要盖过卡片与列表弹层 10001）
    expect(/z-index:\s*\d+/.test(body)).toBe(true)
    const z = Number(/z-index:\s*(\d+)/.exec(body)?.[1] ?? '0')
    expect(z).toBeGreaterThan(10001)
  })

  it('面板会跟随按钮定位、并夹在视口内（含上方放不下时翻到下面）', () => {
    const pop = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'VolumePopover.tsx'), 'utf8')
    expect(pop).toContain('getBoundingClientRect()')
    // 夹到视口内：侧边栏很窄，不能把面板推出屏幕
    expect(pop).toMatch(/Math\.min\(vw - anchor\.right/)
    // 上方空间不足时翻到按钮下方
    expect(pop).toContain('spaceAbove')
    expect(pop).toContain('spaceBelow')
    // 翻面状态写进 DOM（dataset.flip → CSS 的 [data-flip="true"] 决定箭头朝上还是朝下）
    expect(pop).toContain('dataset.flip')
    expect(CSS).toContain('.lxm-volume-pop[data-flip="true"]')
    // 滚动/缩放后要重新量，否则面板会与按钮脱节
    expect(pop).toContain("addEventListener('scroll'")
    expect(pop).toContain("addEventListener('resize'")
    // Esc 可关（键盘可达性）
    expect(pop).toContain("e.key === 'Escape'")
  })

  it('二级面板只有一根竖滑块：不显示数值、也没有喇叭按钮', () => {
    const pop = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'VolumePopover.tsx'), 'utf8')
    // 竖的：writing-mode 是标准做法；direction: rtl 保证「上端 = 100%」。
    // 取 .lxm-volume-pop 之后的那段 CSS（progress 选择器更早出现，不能直接 indexOf range）
    const slider = CSS.slice(CSS.indexOf('.lxm-volume-pop'))
    expect(/writing-mode:\s*vertical-lr/.test(slider)).toBe(true)
    expect(/direction:\s*rtl/.test(slider)).toBe(true)
    // 面板里只有 <input>：没有数值文本、也没有静音按钮
    expect(pop).not.toContain('lxm-volume-head')
    expect(pop).not.toContain('lxm-volume-value')
    expect(pop).not.toContain('toggleMute')
    expect(ruleBody(CSS, '.lxm-volume-head')).toBeUndefined()
    expect(ruleBody(CSS, '.lxm-volume-value')).toBeUndefined()
    // 数值改为无视觉负担的方式提供：aria-valuetext（读屏可读、界面不显示）
    expect(pop).toContain('aria-valuetext')
  })

  it('喇叭按钮用内联 SVG 线稿图标，不用 emoji（与 ⚙/☰/♪ 同一视觉重量）', () => {
    const pop = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'VolumePopover.tsx'), 'utf8')
    expect(pop).toContain('<svg viewBox="0 0 16 16"')
    expect(pop).toContain('fill="currentColor"')
    // emoji 与插件深色线稿 UI 不协调，且各平台渲染不一致：不允许回来
    expect(pop).not.toContain('🔊')
    expect(pop).not.toContain('🔇')
    // 静音态仍有可辨识的表现：斜杠那条 path
    expect(pop).toMatch(/10\.9 6\.2/)
  })

  it('旧的卡片内联弹层样式已清理（不留死规则）', () => {
    // .lxm-volume-wrap 是"面板留在卡片里"那版的锚点容器，现在按钮自己就是锚点
    expect(ruleBody(CSS, '.lxm-volume-wrap')).toBeUndefined()
    expect(ruleBody(CSS, '.lxm-volume')).toBeUndefined()
  })
})

describe('「我的口味」窗口的按钮用法', () => {  /** 读取源码（测试跑在 .test-dist/tests 下，源码仍在仓库里）。 */
  const source = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'TasteWindow.tsx'), 'utf8')

  /** 把源码切成一个个 <button …>…</button> 片段。 */
  function buttons(): Array<{ className: string; text: string; typed: boolean }> {
    const out: Array<{ className: string; text: string; typed: boolean }> = []
    for (const chunk of source.split('<button').slice(1)) {
      // 标签结束位置要跳过箭头函数里的 `=>`（否则会把整段后续源码当成按钮内容）
      let end = -1
      for (let i = 0; i < chunk.length; i++) {
        if (chunk[i] === '>' && chunk[i - 1] !== '=') {
          end = i
          break
        }
      }
      if (end < 0) continue
      const header = chunk.slice(0, end + 1)
      const close = chunk.indexOf('</button>', end)
      const body = close < 0 ? '' : chunk.slice(end + 1, close)
      const cls = /className="([^"]+)"/.exec(header)?.[1] ?? ''
      // 去掉 JSX 表达式与标签，只留可见文字
      const text = body
        .replace(/\{[^}]*\}/g, '')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, '')
      out.push({ className: cls, text, typed: /type="button"/.test(header) })
    }
    return out
  }

  it('所有按钮都显式声明 type="button"（避免在表单上下文里变成 submit）', () => {
    const missing = buttons().filter((b) => !b.typed)
    expect(missing.map((b) => b.className)).toEqual([])
  })

  it('文字按钮必须带 lxm-btn-text（或使用自适应宽度的按钮类）', () => {
    const SELF_SIZED = ['lxm-btn-text', 'lxm-search-btn', 'lxm-tab', 'lxm-switch']
    const offenders = buttons()
      .filter((b) => b.text.length > 2) // 图标按钮（✕/♪）属于 1~2 字符
      .filter((b) => !SELF_SIZED.some((cls) => b.className.includes(cls)))
      .map((b) => `${b.className} → "${b.text}"`)
    expect(offenders).toEqual([])
  })

  it('图标按钮（遗忘 ✕）保持紧凑的 lxm-btn', () => {
    const forget = buttons().filter((b) => b.className === 'lxm-btn')
    expect(forget).toHaveLength(1)
    expect(forget[0]?.text.length).toBeLessThanOrEqual(2)
  })
})
