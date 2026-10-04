// 音量二级面板（点击喇叭弹出）+ 喇叭按钮本体。
//
// ⚠️ 为什么面板必须挂在 <body> 上（本组件存在的根本原因）：
// 卡片 `.lxm-card` 必须保持 `overflow: hidden`（它是会话侧边栏里的可压缩容器，见 styles.ts
// 的注释 —— 一段不带空格的长报错会把侧边栏撑破），而 overflow:hidden 会**裁掉一切溢出后代**。
// 面板是向上弹出的，只要还留在卡片内部就必然被裁断，z-index 再大也没用（裁剪先于合成发生）。
//
// 这里用**手写 DOM portal**（而不是 react-dom 的 createPortal / createRoot）：
//   - 本插件的契约是"无新增运行时依赖"，而 react-dom 并不在依赖里（只有 react）；
//   - 面板本质是一个原生 <input type=range>，没有 React 子树需要协调。
// 手写 portal 还顺带解决了事件问题：面板不在 React 树里 → 在面板上按下/拖动**不会**
// 冒泡到卡片的 onClick（"打开主窗口"），而 createPortal 会沿 React 树冒泡，需要额外的
// stopPropagation 兜着。
//
// 定位：固定定位 + 实时量按钮矩形
//   - 水平：面板右缘对齐按钮右缘，再夹到视口内（侧边栏窄，不能溢出屏幕）；
//   - 垂直：默认向上弹；上方空间不足时翻到按钮下方（矮窗口里不至于看不见）。
// 滚动/缩放会改变按钮位置：面板跟着按钮走，按钮滚出视口则自动收起。

import { useCallback, useEffect, useRef } from 'react'

/** 面板与按钮之间的间距（px）。 */
const GAP = 6
/** 面板宽度（px），与 CSS 的 .lxm-volume-pop 保持一致 —— 夹取位置时要按它算。 */
const PANEL_W = 30
/** 还没量到真实高度时的估值（首帧用，随后立刻被真实高度修正）。 */
const PANEL_H_FALLBACK = 120

export interface VolumePopoverProps {
  /** 当前音量百分比 0~100（静音时调用方应传 0）。 */
  percent: number
  /** 是否静音（决定图标是否带斜杠）。 */
  muted: boolean
  open: boolean
  onToggle: () => void
  onClose: () => void
  /** 拖动中只本地预览；抬手时调用方提交给 host。 */
  onPreview: (volume: number) => void
  onCommit: (volume: number) => void
}

/** 喇叭图标：线稿 SVG（currentColor），静音/0% 时换成带斜杠的那版。 */
export function VolumeIcon(props: { muted: boolean }): JSX.Element {
  return (
    <svg viewBox="0 0 16 16" width="15" height="15" aria-hidden="true">
      <path
        d="M2.5 6.1h2.2L8.2 3v10L4.7 9.9H2.5z"
        fill="currentColor"
        stroke="currentColor"
        strokeWidth="1.1"
        strokeLinejoin="round"
      />
      {props.muted ? (
        <path d="M10.9 6.2 14 9.3M14 6.2l-3.1 3.1" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      ) : (
        <>
          <path d="M10.7 6.1a3.1 3.1 0 0 1 0 3.8" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          <path d="M12.6 4.4a5.7 5.7 0 0 1 0 7.2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </>
      )}
    </svg>
  )
}

interface Placement {
  top: number
  right: number
  /** true = 翻到按钮下方（上方空间不足）。 */
  below: boolean
}

/** 量出锚点并夹到视口内。 */
function place(anchor: DOMRect, panelH: number): Placement {
  const vw = window.innerWidth
  const vh = window.innerHeight
  // 右缘对齐按钮右缘；同时保证面板完整落在视口内
  const right = Math.max(GAP, Math.min(vw - anchor.right, vw - PANEL_W - GAP))
  const height = panelH > 0 ? panelH : PANEL_H_FALLBACK
  const spaceAbove = anchor.top - GAP * 2
  const spaceBelow = vh - anchor.bottom - GAP * 2
  // 上方放不下、且下方更宽敞 → 翻到下面
  const below = spaceAbove < height && spaceBelow > spaceAbove
  const top = below ? anchor.bottom + GAP : Math.max(GAP, anchor.top - GAP - height)
  return { top, right, below }
}

/** 建面板（原生 DOM）：一根竖滑块，没有数值、没有静音按钮。 */
function createPanel(): { panel: HTMLDivElement; slider: HTMLInputElement } {
  const panel = document.createElement('div')
  panel.className = 'lxm-volume-pop'
  panel.setAttribute('role', 'group')
  const slider = document.createElement('input')
  slider.type = 'range'
  slider.min = '0'
  slider.max = '100'
  slider.step = '1'
  slider.setAttribute('aria-label', '音量')
  panel.appendChild(slider)
  return { panel, slider }
}

export function VolumePopover(props: VolumePopoverProps): JSX.Element {
  const { percent, muted, open, onToggle, onClose, onPreview, onCommit } = props
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const sliderRef = useRef<HTMLInputElement | null>(null)
  const draggingRef = useRef(false)
  const posRef = useRef<Placement | null>(null)

  const reposition = useCallback((): void => {
    const anchor = anchorRef.current
    const panel = panelRef.current
    if (!anchor || !panel) return
    const rect = anchor.getBoundingClientRect()
    // 按钮滚出视口（含被折叠）：收起面板，否则浮层会孤零零留在屏幕上
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      onClose()
      return
    }
    const next = place(rect, panel.offsetHeight)
    const prev = posRef.current
    if (prev && prev.top === next.top && prev.right === next.right && prev.below === next.below) return
    posRef.current = next
    panel.style.top = `${next.top}px`
    panel.style.right = `${next.right}px`
    panel.dataset.flip = String(next.below)
  }, [onClose])

  // 面板的生命周期：打开时挂到 body 并接事件；关闭/卸载时拆干净（portal 是手写的，
  // 没有 React 帮忙回收，必须自己 remove + removeEventListener）
  useEffect(() => {
    if (!open) return
    const { panel, slider } = createPanel()
    panelRef.current = panel
    sliderRef.current = slider
    document.body.appendChild(panel)

    const valueOf = (): number => Number(slider.value) / 100
    const onPointerDown = (): void => {
      draggingRef.current = true
    }
    const onPointerUp = (): void => {
      draggingRef.current = false
      onCommit(valueOf())
    }
    const onInput = (): void => {
      // 拖动中只本地预览（抬手才提交），否则一次拖动会打几十个 RPC。
      // 键盘方向键不会先派发 pointerdown → dragging 为 false → 直接提交（一次按键一次提交）。
      if (draggingRef.current) onPreview(valueOf())
      else onCommit(valueOf())
    }
    const onPanelDown = (e: PointerEvent): void => {
      // 面板不在 React 树里，正常不会冒泡到卡片；这里只是保险：别让页面其它监听吃掉拖动
      e.stopPropagation()
    }
    const onWindowDown = (e: PointerEvent): void => {
      const target = e.target as Node | null
      if (!target) return
      if (panel.contains(target) || anchorRef.current?.contains(target) === true) return
      onClose()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    // 滚动/缩放：面板跟着按钮走。capture 才能收到祖先容器的滚动 —— 但也因此会收到
    // **面板内部**的滚动（悬停面板时滚一下），那种情况不能重定位（否则面板会在指针下面跳走）。
    const onScroll = (e: Event): void => {
      const target = e.target as Node | null
      if (target && panel.contains(target)) return
      reposition()
    }
    const onResize = (): void => reposition()

    slider.addEventListener('pointerdown', onPointerDown)
    slider.addEventListener('pointerup', onPointerUp)
    slider.addEventListener('input', onInput)
    panel.addEventListener('pointerdown', onPanelDown)
    window.addEventListener('pointerdown', onWindowDown)
    window.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)

    return () => {
      slider.removeEventListener('pointerdown', onPointerDown)
      slider.removeEventListener('pointerup', onPointerUp)
      slider.removeEventListener('input', onInput)
      panel.removeEventListener('pointerdown', onPanelDown)
      window.removeEventListener('pointerdown', onWindowDown)
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      panel.remove()
      panelRef.current = null
      sliderRef.current = null
      posRef.current = null
    }
  }, [open, onClose, onPreview, onCommit, reposition])

  // 打开时先定位一次（面板已在 DOM 里，量得到真实高度），下一帧再修一次：
  // 位置计算依赖实测高度，而首帧的字体渲染高度无法提前算准。
  useEffect(() => {
    if (!open) return
    reposition()
    const raf = requestAnimationFrame(reposition)
    return () => cancelAnimationFrame(raf)
  }, [open, reposition])

  // 把 host/store 的音量同步进原生控件（拖动中也要跟 —— 预览值会一路回写到 state）
  useEffect(() => {
    const panel = panelRef.current
    const slider = sliderRef.current
    if (!panel || !slider) return
    const value = String(percent)
    if (slider.value !== value) slider.value = value
    slider.setAttribute('aria-valuetext', `${percent}%`)
    panel.setAttribute('aria-label', `音量 ${percent}%`)
    panel.title = `音量 ${percent}%（Esc 关闭）`
    // 轨道渐变靠这个变量画"已设音量"，见 styles.ts 的 .lxm-volume-pop
    slider.style.setProperty('--lxm-vol', String(percent))
  }, [percent, open])

  // 只渲染按钮：面板是手写 portal，不参与 React 的 DOM 树
  return (
    <button
      ref={anchorRef}
      type="button"
      className="lxm-btn"
      aria-label="音量"
      aria-expanded={open}
      title={`音量 ${percent}%（点击调节）`}
      onClick={(e) => {
        e.stopPropagation()
        onToggle()
      }}
    >
      <VolumeIcon muted={muted} />
    </button>
  )
}
