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

describe('「我的口味」窗口的按钮用法', () => {
  /** 读取源码（测试跑在 .test-dist/tests 下，源码仍在仓库里）。 */
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
