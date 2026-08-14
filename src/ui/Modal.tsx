// 可拖动、可调大小、记忆位置的模态窗口（模块2/3 共用）。

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

const DEFAULT_BOUNDS: Bounds = { x: 160, y: 120, w: 640, h: 480 }
const MIN_W = 420
const MIN_H = 320

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export interface DraggableWindowProps {
  title: string
  storageKey: string
  onClose: () => void
  children: ReactNode
}

export function DraggableWindow(props: DraggableWindowProps): JSX.Element {
  const { title, storageKey, onClose, children } = props
  const [bounds, setBounds] = useState<Bounds>(() => {
    try {
      const raw = localStorage.getItem(storageKey)
      if (raw) {
        const b = JSON.parse(raw) as Bounds
        if (typeof b.x === 'number' && typeof b.y === 'number' && typeof b.w === 'number' && typeof b.h === 'number') {
          return { x: b.x, y: b.y, w: Math.max(MIN_W, b.w), h: Math.max(MIN_H, b.h) }
        }
      }
    } catch {
      // 忽略损坏的存储
    }
    return DEFAULT_BOUNDS
  })
  const ref = useRef<HTMLDivElement | null>(null)
  const dragState = useRef<{ mode: 'move' | 'resize'; startX: number; startY: number; startBounds: Bounds } | null>(null)

  useEffect(() => {
    const onMove = (e: PointerEvent): void => {
      const d = dragState.current
      if (!d) return
      const dx = e.clientX - d.startX
      const dy = e.clientY - d.startY
      if (d.mode === 'move') {
        setBounds((b) => ({ ...b, x: b.x + dx, y: b.y + dy }))
      } else {
        setBounds((b) => ({ ...b, w: clamp(b.w + dx, MIN_W, window.innerWidth - 40), h: clamp(b.h + dy, MIN_H, window.innerHeight - 40) }))
      }
      dragState.current = { ...d, startX: e.clientX, startY: e.clientY }
    }
    const onUp = (): void => {
      dragState.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
  }, [])

  const persist = useCallback((b: Bounds) => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(b))
    } catch {
      // 忽略存储失败
    }
  }, [storageKey])

  useEffect(() => {
    persist(bounds)
  }, [bounds, persist])

  const onPointerDown = (mode: 'move' | 'resize') => (e: React.PointerEvent): void => {
    if (e.button !== 0) return
    dragState.current = { mode, startX: e.clientX, startY: e.clientY, startBounds: bounds }
    e.preventDefault()
  }

  return (
    <div className="lxm-window" ref={ref} style={{ left: bounds.x, top: bounds.y, width: bounds.w, height: bounds.h }} role="dialog" aria-label={title}>
      <div className="lxm-window-titlebar" onPointerDown={onPointerDown('move')}>
        <span className="lxm-window-title">{title}</span>
        <button type="button" className="lxm-window-close" aria-label="关闭" onClick={onClose}>✕</button>
      </div>
      <div className="lxm-window-body">{children}</div>
      <div className="lxm-window-resize" onPointerDown={onPointerDown('resize')} aria-hidden="true" />
    </div>
  )
}
