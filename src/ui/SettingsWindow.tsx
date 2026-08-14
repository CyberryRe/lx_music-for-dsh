// 设置窗口（模块3）：音源管理（导入/启停/删除/排序）、音质策略（全局音质/每音源平台优先级）、
// 自动拉取规则（切歌自动最高音质/降级策略）。点击侧边栏卡片的齿轮打开。

import { useRef, useState, useSyncExternalStore } from 'react'
import type { LxStore } from './store'
import type { DraggableWindowProps } from './Modal'
import type { MusicSource, Quality, SourceEntry } from '../shared/types'

const SOURCE_LABEL: Record<string, string> = {
  kw: '酷我',
  wy: '网易云',
  kg: '酷狗',
  tx: 'QQ音乐',
  mg: '咪咕',
  local: '本地',
}

const QUALITY_OPTIONS: Quality[] = ['128k', '320k', 'flac', 'flac24bit', 'flac32bit', 'wav']

export interface SettingsWindowProps {
  store: LxStore
  Window: (props: DraggableWindowProps) => JSX.Element
}

type Tab = 'sources' | 'quality' | 'auto'

export function LxSettingsWindow(props: SettingsWindowProps): JSX.Element {
  const { store, Window } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const settings = snapshot.settings
  const sources = snapshot.sources ?? []
  const [tab, setTab] = useState<Tab>('sources')

  // 导入表单
  const fileRef = useRef<HTMLInputElement | null>(null)
  const [importUrl, setImportUrl] = useState('')
  const [scriptText, setScriptText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)
  const [validating, setValidating] = useState(false)
  const [validMsg, setValidMsg] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const readFile = (file: File): void => {
    const reader = new FileReader()
    reader.onload = () => {
      const content = String(reader.result ?? '')
      setScriptText(content)
      setImportMsg(null)
      void store.uploadSource(file.name, content).then((r) => {
        setImporting(false)
        setImportMsg(r.success ? `已导入并启用：${r.id ?? file.name}` : `导入失败：${r.error ?? '未知错误'}`)
      })
    }
    reader.onerror = () => {
      setImporting(false)
      setImportMsg('文件读取失败')
    }
    setImporting(true)
    reader.readAsText(file)
  }

  const doImportUrl = async (): Promise<void> => {
    const url = importUrl.trim()
    if (!url) return
    setImporting(true)
    setImportMsg(null)
    try {
      const r = await store.importSource(url)
      setImportMsg(r.success ? `已从 URL 导入并启用：${r.id ?? url}` : `导入失败：${r.error ?? '未知错误'}`)
    } catch (err) {
      setImportMsg(`导入失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setImporting(false)
    }
  }

  const doValidate = async (): Promise<void> => {
    if (!scriptText.trim()) return
    setValidating(true)
    setValidMsg(null)
    try {
      const r = await store.validateSource(scriptText)
      setValidMsg(r.valid ? `校验通过，注册平台：${(r.sources ?? []).join(', ')}` : `校验失败：${r.error ?? '未知错误'}`)
    } catch (err) {
      setValidMsg(`校验失败：${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setValidating(false)
    }
  }

  const doTest = async (): Promise<void> => {
    setTesting(true)
    try {
      await store.saveSettings({ lxServerUrl: settings?.lxServerUrl ?? '' })
      setImportMsg(`服务端模式：${snapshot.connected ? '已连接' : '不可达（将使用内置 mock）'}`)
    } finally {
      setTesting(false)
    }
  }

  const moveSource = (index: number, delta: -1 | 1): void => {
    const target = index + delta
    if (target < 0 || target >= sources.length) return
    const ids = sources.map((s) => s.id)
    const [moved] = ids.splice(index, 1)
    if (!moved) return
    ids.splice(target, 0, moved)
    void store.reorderSources(ids)
  }

  /** 每音源平台优先级（↑↓ 调整）。 */
  const movePlatform = (source: SourceEntry, index: number, delta: -1 | 1): void => {
    if (!settings) return
    const key = source.id
    const list = [...(settings.perSourcePlatformPriority[key] ?? ((source.supportedSources ?? []) as MusicSource[]))]
    const target = index + delta
    if (target < 0 || target >= list.length) return
    const [moved] = list.splice(index, 1)
    if (!moved) return
    list.splice(target, 0, moved)
    void store.saveSettings({ perSourcePlatformPriority: { ...settings.perSourcePlatformPriority, [key]: list } })
  }

  const save = (partial: Partial<NonNullable<typeof settings>>): void => {
    if (!settings) return
    void store.saveSettings(partial)
  }

  return (
    <Window title="LX Music 设置" storageKey="lxMusic.window.settings" onClose={() => store.closeSettings()}>
      <div className="lxm-tabs">
        <button type="button" className="lxm-tab" data-active={tab === 'sources'} onClick={() => setTab('sources')}>音源管理</button>
        <button type="button" className="lxm-tab" data-active={tab === 'quality'} onClick={() => setTab('quality')}>音质策略</button>
        <button type="button" className="lxm-tab" data-active={tab === 'auto'} onClick={() => setTab('auto')}>自动拉取</button>
      </div>

      {tab === 'sources' && (
        <div className="lxm-panel">
          <div className="lxm-settings-grid">
            <div className="lxm-field">
              <span className="lxm-field-label">导入音源脚本（.js，符合 LX Music 音源规范）</span>
              <div className="lxm-toolbar">
                <input ref={fileRef} type="file" accept=".js" style={{ display: 'none' }} onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) readFile(f)
                }} />
                <button type="button" className="lxm-btn" disabled={importing} onClick={() => fileRef.current?.click()}>{importing ? '导入中…' : '选择文件'}</button>
                <input className="lxm-input" placeholder="https://…/source.js（URL 导入）" value={importUrl} style={{ flex: 1 }} onChange={(e) => setImportUrl(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void doImportUrl() }} />
                <button type="button" className="lxm-btn" disabled={importing || !importUrl.trim()} onClick={() => void doImportUrl()}>URL 导入</button>
              </div>
              <textarea className="lxm-textarea" placeholder="或直接粘贴脚本内容…" rows={4} value={scriptText} onChange={(e) => setScriptText(e.target.value)} />
              <div className="lxm-toolbar">
                <button type="button" className="lxm-btn" disabled={validating || !scriptText.trim()} onClick={() => void doValidate()}>{validating ? '校验中…' : '校验脚本'}</button>
                <button type="button" className="lxm-btn" disabled={importing || !scriptText.trim()} onClick={() => { void store.uploadSource('pasted-source.js', scriptText).then((r) => setImportMsg(r.success ? `已导入并启用：${r.id ?? 'pasted-source.js'}` : `导入失败：${r.error ?? '未知错误'}`)) }}>导入粘贴内容</button>
              </div>
              {validMsg && <div className="lxm-field-hint">{validMsg}</div>}
              {importMsg && <div className="lxm-field-hint">{importMsg}</div>}
            </div>

            <span className="lxm-section-title">已导入音源（{sources.length}）— 调整顺序即解析优先级</span>
            <div className="lxm-list" style={{ flex: 'none', maxHeight: 260 }}>
              {sources.length === 0 && <div className="lxm-empty">暂无音源 — 导入 lx-music-desktop 音源脚本后即可解析直链（搜索无需音源，由内置 SDK 提供）</div>}
              {sources.map((s, i) => {
                const platforms = (s.supportedSources ?? []) as MusicSource[]
                const prio = (settings?.perSourcePlatformPriority[s.id] ?? platforms) as MusicSource[]
                return (
                  <div key={s.id} className="lxm-source-row">
                    <div className="lxm-source-head">
                      <span className="lxm-drag-handle" title="排序手柄">⠿</span>
                      <div className="lxm-source-meta">
                        <div className="lxm-source-name">{s.name} <span className="lxm-field-hint">v{s.version ?? '?'}</span></div>
                        <div className="lxm-source-sub">{s.author ?? '未知作者'} · {platforms.map((p) => SOURCE_LABEL[p] ?? p).join('、') || '无平台'}</div>
                      </div>
                      {s.status && <span className="lxm-source-status" data-ok={s.status === 'success'}>{s.status === 'success' ? '运行正常' : '加载失败'}</span>}
                      <button type="button" className="lxm-btn" title="上移" disabled={i === 0} onClick={() => moveSource(i, -1)}>↑</button>
                      <button type="button" className="lxm-btn" title="下移" disabled={i === sources.length - 1} onClick={() => moveSource(i, 1)}>↓</button>
                      <button
                        type="button"
                        className="lxm-btn"
                        role="switch"
                        aria-checked={s.enabled}
                        title={s.enabled ? '点击禁用' : '点击启用'}
                        onClick={() => void store.toggleSource(s.id, !s.enabled)}
                      >
                        {s.enabled ? '● 启用' : '○ 禁用'}
                      </button>
                      <button type="button" className="lxm-btn" title="删除" onClick={() => { if (confirm(`删除音源「${s.name}」？`)) void store.deleteSource(s.id) }}>✕</button>
                    </div>
                    {s.error && <div className="lxm-field-hint">{s.error}</div>}
                    {platforms.length > 1 && (
                      <div className="lxm-field">
                        <span className="lxm-field-hint">平台优先级（影响解析回退顺序）：</span>
                        <div className="lxm-prio-list">
                          {prio.map((p, pi) => (
                            <div key={p} className="lxm-prio-item">
                              <span className="lxm-badge lxm-badge-gray">{pi + 1}</span>
                              <span style={{ flex: 1 }}>{SOURCE_LABEL[p] ?? p}</span>
                              <button type="button" className="lxm-btn" disabled={pi === 0} onClick={() => movePlatform(s, pi, -1)}>↑</button>
                              <button type="button" className="lxm-btn" disabled={pi === prio.length - 1} onClick={() => movePlatform(s, pi, 1)}>↓</button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      )}

      {tab === 'quality' && settings && (
        <div className="lxm-panel">
          <div className="lxm-settings-grid">
            <div className="lxm-field">
              <span className="lxm-field-label">全局默认音质</span>
              <select className="lxm-select" value={settings.defaultQuality} onChange={(e) => save({ defaultQuality: e.target.value as Quality })}>
                {QUALITY_OPTIONS.map((q) => <option key={q} value={q}>{q}</option>)}
              </select>
              <span className="lxm-field-hint">播放与 LLM 点歌时的默认请求音质；歌曲不支持时按降级链回退。</span>
            </div>
            <div className="lxm-field">
              <span className="lxm-field-label">音质降级链（解析失败时依次尝试）</span>
              <div className="lxm-toolbar">
                {settings.qualityFallbackChain.map((q) => <span key={q} className="lxm-badge">{q}</span>)}
              </div>
              <span className="lxm-field-hint">可在配置（cordis.patch.yml）中修改 qualityFallbackChain。</span>
            </div>
            <div className="lxm-field">
              <span className="lxm-field-label">搜索平台优先级（顺序尝试，首个有结果的平台胜出）</span>
              <div className="lxm-prio-list">
                {settings.platformPriority.map((p, i) => (
                  <div key={p} className="lxm-prio-item">
                    <span className="lxm-badge lxm-badge-gray">{i + 1}</span>
                    <span style={{ flex: 1 }}>{SOURCE_LABEL[p] ?? p}</span>
                    <button type="button" className="lxm-btn" disabled={i === 0} onClick={() => {
                      const list = [...settings.platformPriority]
                      const [m] = list.splice(i, 1)
                      if (m) {
                        list.splice(i - 1, 0, m)
                        save({ platformPriority: list })
                      }
                    }}>↑</button>
                    <button type="button" className="lxm-btn" disabled={i === settings.platformPriority.length - 1} onClick={() => {
                      const list = [...settings.platformPriority]
                      const [m] = list.splice(i, 1)
                      if (m) {
                        list.splice(i + 1, 0, m)
                        save({ platformPriority: list })
                      }
                    }}>↓</button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {tab === 'auto' && settings && (
        <div className="lxm-panel">
          <div className="lxm-settings-grid">
            <div className="lxm-switch-row">
              <div>
                <div className="lxm-field-label">切歌时自动拉取最高音质</div>
                <div className="lxm-field-hint">播放列表切换歌曲时，优先请求歌曲支持的最高音质（按降级链）。</div>
              </div>
              <button type="button" className="lxm-switch" data-on={settings.autoPullHighestOnSwitch} role="switch" aria-checked={settings.autoPullHighestOnSwitch} onClick={() => save({ autoPullHighestOnSwitch: !settings.autoPullHighestOnSwitch })} />
            </div>
            <div className="lxm-field">
              <span className="lxm-field-label">拉取失败降级策略</span>
              <select className="lxm-select" value={settings.fallbackStrategy} onChange={(e) => save({ fallbackStrategy: e.target.value as typeof settings.fallbackStrategy })}>
                <option value="both">先降音质，再换平台（推荐）</option>
                <option value="next-quality">仅顺序降音质</option>
                <option value="next-platform">仅切换平台</option>
              </select>
              <span className="lxm-field-hint">音质解析失败时：降音质链依次重试；换平台按「音质策略」中的平台优先级重新定位同曲。</span>
            </div>
            <div className="lxm-field">
              <span className="lxm-field-label">数据源模式</span>
              <div className="lxm-toolbar">
                <input className="lxm-input" placeholder="http://127.0.0.1:23332（可选，仅 lxserver 模式需要）" value={settings.lxServerUrl} style={{ flex: 1 }} onChange={(e) => save({ lxServerUrl: e.target.value })} />
                <select className="lxm-select" value={settings.providerMode} onChange={(e) => save({ providerMode: e.target.value as typeof settings.providerMode })}>
                  <option value="auto">自动（有地址用服务端，否则内置引擎）</option>
                  <option value="engine">内置引擎（完全独立，推荐）</option>
                  <option value="lxserver">lxserver 服务端</option>
                  <option value="mock">内置演示数据</option>
                </select>
                <button type="button" className="lxm-btn" disabled={testing} onClick={() => void doTest()}>{testing ? '测试中…' : '测试连接'}</button>
              </div>
              <span className="lxm-field-hint">内置引擎：搜索使用内置音乐 SDK（酷我/酷狗/QQ/网易/咪咕），直链解析使用「音源管理」中的音源脚本，无需任何外部服务。</span>
              {importMsg && <div className="lxm-field-hint">{importMsg}</div>}
            </div>
            <div className="lxm-field">
              <span className="lxm-field-label">LLM 点歌限流（次/分钟）</span>
              <input
                className="lxm-input"
                type="number"
                min={1}
                max={120}
                value={settings.rateLimitPerMinute}
                style={{ width: 120 }}
                onChange={(e) => save({ rateLimitPerMinute: Math.max(1, Number(e.target.value) || 1) })}
              />
              <span className="lxm-field-hint">防止模型在编程间隙频繁点歌；超出后工具会提示稍后再试。</span>
            </div>
          </div>
        </div>
      )}
    </Window>
  )
}
