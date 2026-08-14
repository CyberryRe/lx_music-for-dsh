// 主窗口（模块2）：搜索（关键词/歌手/平台过滤）+ 播放列表管理（拖拽排序/删除/清空/导出）。
// 点击侧边栏卡片主体打开。

import { useState, useSyncExternalStore } from 'react'
import type { LxStore } from './store'
import type { DraggableWindowProps } from './Modal'
import type { MusicInfo, MusicSource } from '../shared/types'

const SOURCE_LABEL: Record<string, string> = {
  kw: '酷我',
  wy: '网易云',
  kg: '酷狗',
  tx: 'QQ音乐',
  mg: '咪咕',
  local: '本地',
}

export interface MainWindowProps {
  store: LxStore
  Window: (props: DraggableWindowProps) => JSX.Element
}

type Tab = 'search' | 'playlist'

export function LxMainWindow(props: MainWindowProps): JSX.Element {
  const { store, Window } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const state = snapshot.state
  const [tab, setTab] = useState<Tab>('search')
  const [query, setQuery] = useState('')
  const [singer, setSinger] = useState('')
  const [source, setSource] = useState<string>('')
  const [searching, setSearching] = useState(false)
  const [results, setResults] = useState<MusicInfo[]>([])
  const [searchError, setSearchError] = useState<string | null>(null)
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [dropIndex, setDropIndex] = useState<number | null>(null)

  const doSearch = async (): Promise<void> => {
    const q = query.trim()
    if (!q) return
    setSearching(true)
    setSearchError(null)
    try {
      const outcome = await store.search({
        query: q,
        singer: singer.trim() || undefined,
        sources: source ? [source as MusicSource] : undefined,
        limit: 30,
      })
      setResults(outcome.results)
      if (outcome.results.length === 0 && outcome.attempts.every((a) => a.status === 'fail')) {
        setSearchError(`搜索失败：${outcome.attempts.map((a) => `${a.source} ${a.error ?? ''}`).join('；') || '无结果'}`)
      }
    } catch (err) {
      setSearchError(err instanceof Error ? err.message : String(err))
    } finally {
      setSearching(false)
    }
  }

  const downloadExport = async (): Promise<void> => {
    const text = await store.exportList()
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `lx-playlist-${new Date().toISOString().slice(0, 10)}.txt`
    a.click()
    URL.revokeObjectURL(url)
  }

  const playlist = state?.playlist ?? []
  const currentIndex = state?.currentIndex ?? -1

  const onDragStart = (index: number) => (): void => {
    setDragIndex(index)
  }
  const onDragOver = (index: number) => (e: React.DragEvent): void => {
    e.preventDefault()
    if (dropIndex !== index) setDropIndex(index)
  }
  const onDrop = (index: number) => (e: React.DragEvent): void => {
    e.preventDefault()
    if (dragIndex === null) return
    const ids = [...playlist]
    const [moved] = ids.splice(dragIndex, 1)
    if (!moved) return
    const target = index > dragIndex ? index - 1 : index
    ids.splice(target, 0, moved)
    void store.reorderList(ids.map((m) => m.id))
    setDragIndex(null)
    setDropIndex(null)
  }
  const onDragEnd = (): void => {
    setDragIndex(null)
    setDropIndex(null)
  }

  return (
    <Window title="LX Music" storageKey="lxMusic.window.main" onClose={() => store.closeMain()}>
      <div className="lxm-tabs">
        <button type="button" className="lxm-tab" data-active={tab === 'search'} onClick={() => setTab('search')}>搜索</button>
        <button type="button" className="lxm-tab" data-active={tab === 'playlist'} onClick={() => setTab('playlist')}>播放列表 ({playlist.length})</button>
      </div>

      {tab === 'search' ? (
        <div className="lxm-panel">
          <div className="lxm-searchbar">
            <input
              className="lxm-input"
              placeholder="关键词（歌名/歌手/模糊描述）"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doSearch()
              }}
            />
            <input
              className="lxm-input"
              placeholder="歌手过滤（可选）"
              value={singer}
              style={{ width: 120 }}
              onChange={(e) => setSinger(e.target.value)}
            />
            <select className="lxm-select" value={source} onChange={(e) => setSource(e.target.value)} aria-label="平台">
              <option value="">全部平台</option>
              {(Object.keys(SOURCE_LABEL) as MusicSource[]).map((s) => (
                <option key={s} value={s}>{SOURCE_LABEL[s]}</option>
              ))}
            </select>
            <button type="button" className="lxm-search-btn" disabled={searching || !query.trim()} onClick={() => void doSearch()}>
              {searching ? '搜索中…' : '搜索'}
            </button>
          </div>
          {searchError && <div className="lxm-error">{searchError}</div>}
          <div className="lxm-list">
            {results.length === 0 && !searching && <div className="lxm-empty">输入关键词开始搜索</div>}
            {results.map((m) => (
              <div key={m.id} className="lxm-row" title={`${m.name} - ${m.singer}`}>
                {m.meta.picUrl ? <img className="lxm-row-cover" src={m.meta.picUrl} alt="" loading="lazy" /> : <div className="lxm-row-cover" />}
                <div className="lxm-row-main">
                  <div className="lxm-row-name">{m.name}</div>
                  <div className="lxm-row-sub">{m.singer} · {SOURCE_LABEL[m.source] ?? m.source}</div>
                </div>
                <div style={{ display: 'flex', gap: 3, flex: 'none', maxWidth: 120, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {(m.meta.qualitys ?? []).slice(0, 3).map((q) => (
                    <span key={q.type} className="lxm-badge lxm-badge-gray">{q.type}</span>
                  ))}
                </div>
                <span className="lxm-dur">{m.interval ?? ''}</span>
                <button
                  type="button"
                  className="lxm-btn"
                  style={{ width: 'auto', padding: '2px 8px', fontSize: 12 }}
                  title="添加到队尾"
                  onClick={() => void store.addMusic([m], 'tail')}
                >
                  +队尾
                </button>
                <button
                  type="button"
                  className="lxm-btn"
                  style={{ width: 'auto', padding: '2px 8px', fontSize: 12 }}
                  title="下一首播放"
                  onClick={() => void store.addMusic([m], 'next')}
                >
                  +下一首
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="lxm-panel">
          <div className="lxm-toolbar">
            <button type="button" className="lxm-btn" disabled={playlist.length === 0} onClick={() => void store.clearList()}>清空列表</button>
            <button type="button" className="lxm-btn" disabled={playlist.length === 0} onClick={() => void downloadExport()}>导出为文本</button>
            <span className="lxm-field-hint">拖拽行可排序，点击行播放</span>
          </div>
          {snapshot.error && <div className="lxm-error">{snapshot.error}</div>}
          <div className="lxm-list">
            {playlist.length === 0 && <div className="lxm-empty">播放列表为空，去「搜索」添加歌曲吧</div>}
            {playlist.map((m, i) => (
              <div
                key={m.id}
                className={`lxm-row${dragIndex === i ? ' lxm-dragging' : ''}${dropIndex === i && dragIndex !== null && dragIndex !== i ? ' lxm-drop-hint' : ''}`}
                data-active={i === currentIndex}
                draggable
                onDragStart={onDragStart(i)}
                onDragOver={onDragOver(i)}
                onDrop={onDrop(i)}
                onDragEnd={onDragEnd}
                onClick={() => void store.playAt(i)}
                title={`${m.name} - ${m.singer}`}
              >
                <span className="lxm-drag-handle" title="拖拽排序">⠿</span>
                <span className="lxm-dur" style={{ minWidth: 22 }}>{i + 1}</span>
                {m.meta.picUrl ? <img className="lxm-row-cover" src={m.meta.picUrl} alt="" loading="lazy" /> : <div className="lxm-row-cover" />}
                <div className="lxm-row-main">
                  <div className="lxm-row-name">{m.name}</div>
                  <div className="lxm-row-sub">{m.singer} · {SOURCE_LABEL[m.source] ?? m.source}</div>
                </div>
                <span className="lxm-dur">{m.interval ?? ''}</span>
                <button
                  type="button"
                  className="lxm-btn"
                  aria-label="删除"
                  title="从列表删除"
                  onClick={(e) => {
                    e.stopPropagation()
                    void store.removeMusic(m.id)
                  }}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </Window>
  )
}
