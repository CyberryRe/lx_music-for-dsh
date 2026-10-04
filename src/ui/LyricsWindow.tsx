// 滚动歌词窗口（1.3.0）。
//
// 设计要点：
//   - **host 解析，client 渲染**：歌词文本在 host 侧被解析成 `LyricDoc`（行 + 逐字轴），
//     这里只做"当前行/当前字"的查表与滚动，不做任何正则解析。
//   - 自动跟随可以被打断：用户手动滚动后不再抢滚动条，点「回到当前行」恢复；换歌自动恢复。
//   - 逐字高亮（卡拉OK）只在歌词确实带逐字时间轴时出现（`line.words`），否则退化成整行高亮。
//   - 点某一行 = 跳到那一句（seek）。

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { LxStore } from './store'
import type { DraggableWindowProps } from './Modal'
import type { LyricLine } from '../shared/types'
import { findLyricLineIndex, findLyricWordIndex } from '../shared/lrc'
import { sourceLabel } from '../shared/types'

export interface LyricsWindowProps {
  store: LxStore
  Window: (props: DraggableWindowProps) => JSX.Element
}

const FONT_KEY = 'lxm-lyric-font-scale'
const FOLLOW_LEAD_IN = 0.2

function readFontScale(): number {
  try {
    const raw = Number(localStorage.getItem(FONT_KEY))
    if (Number.isFinite(raw) && raw >= 0.7 && raw <= 2) return raw
  } catch {
    // 忽略损坏的存储
  }
  return 1
}

export function LxLyricsWindow(props: LyricsWindowProps): JSX.Element {
  const { store, Window } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const state = snapshot.state
  const doc = snapshot.lyric
  const lines = doc?.lines ?? []
  const progress = state?.progress ?? 0
  const [follow, setFollow] = useState(true)
  const [showTranslation, setShowTranslation] = useState(true)
  const [fontScale, setFontScale] = useState(readFontScale)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const lineRefs = useRef<Array<HTMLDivElement | null>>([])

  const activeIndex = useMemo(() => findLyricLineIndex(lines, progress, FOLLOW_LEAD_IN), [lines, progress])
  const activeLine: LyricLine | null = activeIndex >= 0 ? (lines[activeIndex] ?? null) : null
  // 行内已唱到第几个字（-1 = 还没到第一个字）
  const activeWordIndex = activeLine
    ? findLyricWordIndex(activeLine.words, progress - activeLine.time)
    : -1

  useEffect(() => {
    try {
      localStorage.setItem(FONT_KEY, String(fontScale))
    } catch {
      // 忽略存储失败
    }
  }, [fontScale])

  const scrollToActive = useCallback((smooth: boolean) => {
    const body = bodyRef.current
    const el = activeIndex >= 0 ? lineRefs.current[activeIndex] : null
    if (!body || !el) return
    // 手动算 scrollTop 而不是 scrollIntoView：后者在嵌套滚动容器里会连带滚动祖先
    const target = el.offsetTop - body.clientHeight / 2 + el.clientHeight / 2
    const top = Math.max(0, target - 12)
    try {
      body.scrollTo({ top, behavior: smooth ? 'smooth' : 'auto' })
    } catch {
      body.scrollTop = top
    }
  }, [activeIndex])

  // 跟随当前行；用户手动滚动后停止跟随（见 onUserScroll）
  useEffect(() => {
    if (!follow) return
    scrollToActive(true)
  }, [follow, activeIndex, scrollToActive])

  // 换歌时恢复跟随（否则用户切歌后歌词停在上一首的位置）
  const songKey = state?.current ? `${state.current.source}|${state.current.id}` : ''
  useEffect(() => {
    setFollow(true)
  }, [songKey])

  const onUserScroll = (): void => {
    if (follow) setFollow(false)
  }

  const title = state?.current ? `${state.current.name} - ${state.current.singer}` : '歌词'
  const badge = doc && doc.lines.length > 0
    ? `${doc.source === 'script' ? '音源脚本' : doc.source === 'sdk' ? '内置 SDK' : doc.source === 'lxserver' ? 'lxserver' : '演示'}${doc.platform ? ` · ${sourceLabel(doc.platform)}` : ''}${doc.hasWordTiming ? ' · 逐字' : ''}`
    : ''
  const emptyText = snapshot.lyricError
    ?? (snapshot.lyricLoading ? '正在获取歌词…' : (doc?.note ?? '暂无歌词'))

  return (
    <Window title={`歌词 · ${title}`} storageKey="lxm-lyrics-bounds" onClose={() => store.closeLyrics()}>
      <div className="lxm-toolbar lxm-lyric-toolbar">
        <span className="lxm-lyric-song" title={title}>{title}</span>
        {badge ? <span className="lxm-badge lxm-badge-gray">{badge}</span> : null}
        <span className="lxm-spacer" />
        {doc?.hasTranslation ? (
          <button
            type="button"
            className="lxm-btn lxm-btn-text"
            data-active={showTranslation}
            title="显示/隐藏翻译"
            onClick={() => setShowTranslation((v) => !v)}
          >
            译
          </button>
        ) : null}
        <button type="button" className="lxm-btn lxm-btn-text" title="缩小字号" onClick={() => setFontScale((v) => Math.max(0.7, Math.round((v - 0.1) * 10) / 10))}>A-</button>
        <button type="button" className="lxm-btn lxm-btn-text" title="放大字号" onClick={() => setFontScale((v) => Math.min(2, Math.round((v + 0.1) * 10) / 10))}>A+</button>
        <button
          type="button"
          className="lxm-btn lxm-btn-text"
          data-active={follow}
          title="滚动回当前播放的那一句"
          onClick={() => {
            setFollow(true)
            scrollToActive(false)
          }}
        >
          回到当前
        </button>
        <button type="button" className="lxm-btn lxm-btn-text" title="重新获取歌词" onClick={() => void store.reloadLyric()}>刷新</button>
      </div>

      {doc?.plain ? <div className="lxm-field-hint">该平台只提供了纯文本歌词，时间轴是按行数估算的。</div> : null}

      <div
        className="lxm-lyric-body"
        ref={bodyRef}
        style={{ fontSize: `${Math.round(15 * fontScale)}px` }}
        // 只有"用户自己滚动"才停止跟随：点某一行是 seek（seek 后跟到新行才是预期行为）
        onWheel={onUserScroll}
        onTouchMove={onUserScroll}
      >
        {lines.length === 0 ? (
          <div className="lxm-empty">{emptyText}</div>
        ) : (
          <>
            <div className="lxm-lyric-pad" />
            {lines.map((line, index) => {
              const isActive = index === activeIndex
              const words = isActive ? line.words : undefined
              // 逐字片段必须拼回整行文本；拼不上说明平台给的逐字轴与文本不同源
              // （曾出现过"每行第一个字消失"），此时退回整行渲染，宁可不要卡拉OK。
              const useWords = words !== undefined && words.map((w) => w.text).join('') === line.text
              return (
                <div
                  key={`${line.time}-${index}`}
                  ref={(el) => { lineRefs.current[index] = el }}
                  className="lxm-lyric-line"
                  data-active={isActive}
                  data-past={index < activeIndex}
                  title="点击跳到这一句"
                  onClick={() => void store.seek(line.time)}
                >
                  {useWords ? (
                    <span className="lxm-lyric-text">
                      {words!.map((word, wi) => (
                        <span
                          key={`${word.time}-${wi}`}
                          className="lxm-lyric-word"
                          data-on={wi <= activeWordIndex}
                          data-current={wi === activeWordIndex}
                        >
                          {word.text}
                        </span>
                      ))}
                    </span>
                  ) : (
                    <span className="lxm-lyric-text">{line.text}</span>
                  )}
                  {showTranslation && line.tr ? <span className="lxm-lyric-tr">{line.tr}</span> : null}
                  {showTranslation && line.ro ? <span className="lxm-lyric-ro">{line.ro}</span> : null}
                </div>
              )
            })}
            <div className="lxm-lyric-pad" />
          </>
        )}
      </div>

      <div className="lxm-lyric-foot">
        {(() => {
          const smtc = snapshot.smtc
          if (!smtc) return <span className="lxm-field-hint">系统媒体控件：未初始化</span>
          if (!smtc.supported) {
            return <span className="lxm-field-hint" title={smtc.note ?? ''}>系统媒体控件：当前内核不支持（{smtc.note ?? 'navigator.mediaSession 缺失'}）</span>
          }
          const pushed = smtc.title ? `《${smtc.title}》${smtc.artist ? ` - ${smtc.artist}` : ''}` : '未推送'
          return (
            <span className="lxm-field-hint" title={smtc.note ?? ''}>
              系统媒体控件：{smtc.playbackState} · 已推送 {pushed}
              {smtc.artwork ? (smtc.artworkPushed ? ' · 含封面' : ' · 封面未推送') : ' · 无封面'}
              {smtc.note ? ` · ${smtc.note}` : ''}
            </span>
          )
        })()}
      </div>
    </Window>
  )
}
