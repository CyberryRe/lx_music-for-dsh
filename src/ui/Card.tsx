// 侧边栏迷你播放控制卡片（模块1）。
// 注入点：sidebar.footer.action（设置按钮上方）。

import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { LxStore } from './store'
import { secondsToInterval } from '../shared/types'
import { PLAY_MODES, PLAY_MODE_LABEL, nextPlayMode } from './playModes'

export interface CardProps {
  store: LxStore
}

export function LxMusicCard(props: CardProps): JSX.Element {
  const { store } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const state = snapshot.state
  const [listOpen, setListOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const listRef = useRef<HTMLDivElement | null>(null)

  const current = state?.current ?? null
  const progress = state?.progress ?? 0
  const duration = state?.duration ?? 0
  const status = state?.status ?? 'stoped'
  const playing = status === 'playing'
  const playMode = state?.playMode ?? 'list'
  const modeMeta = PLAY_MODES.find((m) => m.value === playMode) ?? PLAY_MODES[0]!

  // 点击外部关闭播放列表 popover
  useEffect(() => {
    if (!listOpen) return
    const onDown = (e: PointerEvent): void => {
      if (listRef.current && !listRef.current.contains(e.target as Node)) setListOpen(false)
    }
    window.addEventListener('pointerdown', onDown)
    return () => window.removeEventListener('pointerdown', onDown)
  }, [listOpen])

  const onSeek = (value: number): void => {
    void store.seek(value)
    setDragging(false)
  }

  const playIcon = playing ? '⏸' : '▶'
  const title = current ? `${current.name} - ${current.singer}` : 'LX Music'
  const cover = current?.meta.picUrl

  return (
    <div
      className="lxm-card"
      title={title}
      role="button"
      tabIndex={0}
      onClick={() => store.openMain()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') store.openMain()
      }}
    >
      <div className="lxm-card-head">
        {cover ? <img className="lxm-cover" src={cover} alt="" loading="lazy" /> : <div className="lxm-cover" />}
        <div className="lxm-title">
          <div className="lxm-name">{current?.name ?? '未在播放'}</div>
          <div className="lxm-singer" title={snapshot.error ?? undefined}>
            {current?.singer ?? (snapshot.connected ? '播放列表为空' : (snapshot.error ?? '连接中…'))}
          </div>
        </div>
        <button
          type="button"
          className="lxm-btn"
          aria-label="设置"
          title="设置"
          onClick={(e) => {
            e.stopPropagation()
            store.openSettings()
          }}
        >
          ⚙
        </button>
      </div>

      <div className="lxm-progress">
        <span className="lxm-time">{secondsToInterval(progress)}</span>
        <input
          type="range"
          min={0}
          max={duration > 0 ? duration : 0}
          step={0.5}
          value={Math.min(progress, duration || progress)}
          disabled={!current}
          aria-label="播放进度"
          onPointerDown={(e) => {
            e.stopPropagation()
            setDragging(true)
          }}
          onPointerUp={(e) => {
            const v = Number((e.target as HTMLInputElement).value)
            onSeek(v)
          }}
          onKeyUp={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') onSeek(Number((e.target as HTMLInputElement).value))
          }}
          onChange={(e) => {
            // 拖动中仅本地更新，pointerup 提交
            const v = Number(e.target.value)
            if (!dragging) {
              void store.seek(v)
            } else {
              store.updateLocalProgress(v)
            }
          }}
        />
        <span className="lxm-time">{secondsToInterval(duration)}</span>
      </div>

      <div className="lxm-controls">
        <div className="lxm-btn-row">
          <button type="button" className="lxm-btn" aria-label="上一首" title="上一首" disabled={!current} onClick={(e) => { e.stopPropagation(); void store.prev() }}>⏮</button>
          <button type="button" className="lxm-btn lxm-btn-primary" aria-label={playing ? '暂停' : '播放'} title={playing ? '暂停' : '播放'} disabled={!current} onClick={(e) => { e.stopPropagation(); void store.togglePlay() }}>{playIcon}</button>
          <button type="button" className="lxm-btn" aria-label="下一首" title="下一首" disabled={!current} onClick={(e) => { e.stopPropagation(); void store.next() }}>⏭</button>
        </div>
        <div className="lxm-btn-row" ref={listRef}>
          <button
            type="button"
            className="lxm-btn lxm-btn-mode"
            aria-label={PLAY_MODE_LABEL[playMode]}
            title={`播放模式：${PLAY_MODE_LABEL[playMode]}（点击循环切换）`}
            onClick={(e) => {
              e.stopPropagation()
              void store.setPlayMode(nextPlayMode(playMode))
            }}
          >
            {modeMeta.icon}
          </button>
          <button
            type="button"
            className="lxm-btn"
            aria-label="播放列表"
            title="播放列表"
            onClick={(e) => {
              e.stopPropagation()
              setListOpen((v) => !v)
            }}
          >
            ☰
          </button>
          {listOpen && (
            <div
              className="lxm-card"
              style={{ position: 'fixed', right: 12, bottom: 96, width: 280, maxHeight: 300, zIndex: 10001, overflowY: 'auto' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="lxm-modes">
                {PLAY_MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    className="lxm-mode-btn"
                    data-active={playMode === m.value}
                    title={m.label}
                    onClick={() => void store.setPlayMode(m.value)}
                  >
                    <span>{m.icon}</span>
                    {m.label}
                  </button>
                ))}
              </div>
              {(state?.playlist ?? []).length === 0 && <div className="lxm-empty">播放列表为空</div>}
              {(state?.playlist ?? []).map((m, i) => (
                <div
                  key={m.id}
                  className="lxm-row"
                  data-active={state?.currentIndex === i}
                  onClick={() => {
                    void store.playAt(i)
                    setListOpen(false)
                  }}
                >
                  {m.meta.picUrl ? <img className="lxm-row-cover" src={m.meta.picUrl} alt="" loading="lazy" /> : <div className="lxm-row-cover" />}
                  <div className="lxm-row-main">
                    <div className="lxm-row-name">{m.name}</div>
                    <div className="lxm-row-sub">{m.singer}</div>
                  </div>
                  <span className="lxm-dur">{m.interval ?? ''}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
