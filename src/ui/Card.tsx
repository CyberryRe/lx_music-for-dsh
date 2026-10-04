// 侧边栏迷你播放控制卡片（模块1）。
// 注入点：sidebar.footer.action（设置按钮上方）。

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { LxStore } from './store'
import { secondsToInterval } from '../shared/types'
import { PLAY_MODES, PLAY_MODE_LABEL, nextPlayMode } from './playModes'
import { VolumePopover } from './VolumePopover'

export interface CardProps {
  store: LxStore
}

export function LxMusicCard(props: CardProps): JSX.Element {
  const { store } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const state = snapshot.state
  const [listOpen, setListOpen] = useState(false)
  const [volumeOpen, setVolumeOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  // 播放列表 popover 的"点外面关闭"用；音量面板由 VolumePopover 自己管（它在 portal 里，
  // 不能靠这个容器的 contains 判断）
  const listRef = useRef<HTMLDivElement | null>(null)

  const current = state?.current ?? null
  const progress = state?.progress ?? 0
  const duration = state?.duration ?? 0
  const status = state?.status ?? 'stoped'
  const playing = status === 'playing'
  const playMode = state?.playMode ?? 'list'
  const modeMeta = PLAY_MODES.find((m) => m.value === playMode) ?? PLAY_MODES[0]!
  const mute = state?.mute ?? false
  const volume = state?.volume ?? 1
  // 静音时进度条显示 0（看得见的"没声音"），拖动即解除静音（setVolume 会一并处理）
  const volumePercent = Math.round((mute ? 0 : volume) * 100)

  // 点击外部关闭播放列表 popover（音量面板在 portal 里，自己管这件事）
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

  // 传给 VolumePopover 的回调都保持稳定引用：面板的定位/监听副作用依赖 onClose，
  // 每次渲染都换新函数会让它反复解绑重绑（面板开着时尤其浪费）。
  const toggleVolume = useCallback((): void => setVolumeOpen((v) => !v), [])
  const closeVolume = useCallback((): void => setVolumeOpen(false), [])
  // 拖动中只本地预览（参数是 0~1），抬手才由 commitVolume 提交给 host
  const previewVolume = useCallback((v: number): void => store.previewVolume(v), [store])
  const commitVolume = useCallback((v: number): void => { void store.setVolume(v) }, [store])

  const playIcon = playing ? '⏸' : '▶'
  const title = current ? `${current.name} - ${current.singer}` : 'LX Music'
  const cover = current?.meta.picUrl
  // 报错单独占一行（换行 + 两行截断 + title 提示完整内容）：直接塞进歌手里会因为
  // 单行省略号而看不到内容，而它偏偏是最需要被看见的文字。
  //
  // host 半边没连上时，最常见的原因是"装了新版本但没彻底重启 DSH"（加载的还是旧代码）。
  // 这个提示必须写在**客户端**：host 挂了之后 remote 调用全失败，只有客户端能显示东西。
  const RESTART_HINT = '插件 host 半边未激活。若你刚安装/更新过插件，请彻底退出并重启 DSH（关窗口不算）——本版本需要完全重启才会加载新代码，该问题下个大版本修复。'
  const errorText = !current && snapshot.error ? `${snapshot.error}\n\n${RESTART_HINT}` : null

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
            {current?.singer ?? (snapshot.connected ? '播放列表为空' : (errorText ? '连接失败' : '连接中…'))}
          </div>
        </div>
        {/* ♪ 入口只在实验性画像**已开启**时出现：未开启时不给入口（在设置窗口的「实验性」页开启） */}
        {snapshot.taste?.enabled ? (
          <button
            type="button"
            className="lxm-btn"
            aria-label="我的口味"
            title="我的口味（音乐画像）"
            onClick={(e) => {
              e.stopPropagation()
              store.openTaste()
            }}
          >
            ♪
          </button>
        ) : null}
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

      {errorText && (
        <div className="lxm-error" title={errorText}>
          {errorText}
        </div>
      )}

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
          {/* 歌词入口（1.3.0）已按需求**先隐藏**：歌词链路（store.openLyrics / getLyric /
              LyricsWindow / WindowsHost）全部保留，日后把这段按钮恢复即可回到 1.3.0 的行为。
              喇叭按钮就放在它原来的位置（播放模式与播放列表之间）。
              二级面板由 VolumePopover 用 portal 挂到 body —— 卡片有 overflow:hidden，
              留在卡片里必然被裁断，见该文件顶部注释。 */}
          <VolumePopover
            percent={volumePercent}
            muted={mute || volumePercent === 0}
            open={volumeOpen}
            onToggle={toggleVolume}
            onClose={closeVolume}
            onPreview={previewVolume}
            onCommit={commitVolume}
          />
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
