// 「我的口味」窗口（1.2.0）：首启引导 + 画像管理。
//
// 两种形态共用同一个窗口：
//   - **引导态**（tasteOnboarding）：首次加载插件时自动弹出，说明画像是什么、数据在哪、
//     可以随时关掉；用户点了"开启/稍后/暂不使用"就结束引导。
//   - **管理态**：三个标签页 —— 口味（榜单 + 一键忘掉）、证据（画像为什么长这样）、设置。
//
// 原则：**所有数据都在本机**（$DSH_HOME/storages），界面里如实写明；每个结论都能追溯到证据。

import { useState, useSyncExternalStore } from 'react'
import type { LxStore } from './store'
import type { DraggableWindowProps } from './Modal'

export interface TasteWindowProps {
  store: LxStore
  Window: (props: DraggableWindowProps) => JSX.Element
}

type Tab = 'profile' | 'evidence' | 'settings'

const BUDGET_LABEL: Record<string, string> = {
  off: '关闭（不注入任何画像）',
  minimal: '精简（3 个候选，不带理由）',
  balanced: '均衡（5 个候选 + 一句理由）',
  rich: '丰富（8 个候选 + 多维理由）',
}

const CONFIDENCE_LABEL: Record<string, string> = {
  none: '无样本',
  low: '样本少',
  medium: '较可信',
  high: '很可信',
}

function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function LxTasteWindow(props: TasteWindowProps): JSX.Element {
  const { store, Window } = props
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)
  const taste = snapshot.taste
  const [tab, setTab] = useState<Tab>('profile')
  const [seed, setSeed] = useState('')
  const [confirmClear, setConfirmClear] = useState(false)

  const busy = snapshot.tasteBusy
  const config = taste?.config ?? null

  // ── 引导态 ────────────────────────────────────────────────────────────────
  if (snapshot.tasteOnboarding) {
    return (
      <Window title="音乐口味记忆" storageKey="lxMusic.window.taste" onClose={() => store.closeTaste()}>
        <div className="lxm-panel">
          <div className="lxm-section-title">这是什么？</div>
          <div className="lxm-field-hint">
            开启后，插件会在本机记录你的收听习惯（听完了、听到一半切走、主动点歌），
            在 AI 主动点歌时优先挑合你口味的歌，而不是让搜索排序替你决定。
          </div>

          <div className="lxm-section-title">数据在哪？</div>
          <div className="lxm-field-hint">
            <b>全部在本机处理，不上传任何数据。</b>
            原始记录只保留有限时间（默认 90 天），聚合后的口味画像可以随时查看、逐条删除或一键清空。
          </div>

          <div className="lxm-section-title">先告诉我几位你喜欢的艺人？（可选）</div>
          <div className="lxm-searchbar">
            <input
              className="lxm-input"
              placeholder="例如：金玟岐, 陈奕迅"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
            />
          </div>
          <div className="lxm-field-hint">用逗号分隔。显式写下的喜好权重最高，且不会随时间衰减。</div>

          <div className="lxm-toolbar" style={{ marginTop: 'auto' }}>
            <button
              className="lxm-search-btn"
              disabled={busy}
              onClick={() => {
                void (async () => {
                  for (const name of seed.split(/[,，、]/).map((s) => s.trim()).filter(Boolean)) {
                    await store.tasteAction({ action: 'like', entity: name })
                  }
                  await store.tasteAction({ action: 'onboard' })
                  store.closeTaste()
                })()
              }}
            >
              开启画像
            </button>
            <button
              className="lxm-btn"
              disabled={busy}
              onClick={() => {
                void store.tasteAction({ action: 'snooze' }).then(() => store.closeTaste())
              }}
            >
              稍后再说
            </button>
            <button
              className="lxm-btn"
              disabled={busy}
              onClick={() => {
                void store
                  .setMemoryConfig({ enabled: false, onboardedAt: new Date().toISOString() })
                  .then(() => store.closeTaste())
              }}
            >
              暂不使用
            </button>
          </div>
          {snapshot.tasteNotice ? <div className="lxm-field-hint">{snapshot.tasteNotice}</div> : null}
        </div>
      </Window>
    )
  }

  // ── 管理态 ────────────────────────────────────────────────────────────────
  const artists = taste?.artists ?? []
  const tracks = taste?.tracks ?? []
  const events = snapshot.tasteEvents ?? []

  return (
    <Window title="我的口味" storageKey="lxMusic.window.taste" onClose={() => store.closeTaste()}>
      <div className="lxm-tabs">
        <button className="lxm-tab" type="button" data-active={tab === 'profile'} onClick={() => setTab('profile')}>
          口味
        </button>
        <button className="lxm-tab" type="button" data-active={tab === 'evidence'} onClick={() => setTab('evidence')}>
          证据
        </button>
        <button className="lxm-tab" type="button" data-active={tab === 'settings'} onClick={() => setTab('settings')}>
          设置
        </button>
      </div>

      {tab === 'profile' ? (
        <div className="lxm-panel">
          <div className="lxm-field-hint">
            {taste?.summary ?? '正在读取…'}
            {taste ? `（样本 ${taste.sampleSize} 次收听）` : ''}
          </div>

          <div className="lxm-searchbar">
            <input
              className="lxm-input"
              placeholder="记住一位你喜欢的艺人…"
              value={seed}
              onChange={(e) => setSeed(e.target.value)}
            />
            <button
              className="lxm-search-btn"
              disabled={busy || !seed.trim()}
              onClick={() => {
                void store.tasteAction({ action: 'like', entity: seed.trim() }).then(() => setSeed(''))
              }}
            >
              记住
            </button>
          </div>

          <div className="lxm-section-title">常听艺人</div>
          <div className="lxm-list">
            {artists.length === 0 ? (
              <div className="lxm-empty">还没有数据。播放几首歌，或直接在上面填写。</div>
            ) : (
              artists.map((a) => (
                <div className="lxm-row" key={a.name}>
                  <div className="lxm-row-main">
                    <div className="lxm-row-name">
                      {a.name}
                      {a.explicit !== 0 ? <span className="lxm-badge"> 明确{a.explicit > 0 ? '喜欢' : '不喜欢'}</span> : null}
                    </div>
                    <div className="lxm-row-sub">
                      {a.plays} 次播放{a.skips > 0 ? ` · ${a.skips} 次跳过` : ''} · 权重 {a.score.toFixed(2)} ·{' '}
                      {CONFIDENCE_LABEL[a.confidence] ?? a.confidence}
                    </div>
                  </div>
                  <button
                    className="lxm-btn"
                    title="让画像忘掉这位艺人"
                    disabled={busy}
                    onClick={() => void store.tasteAction({ action: 'forget', entity: a.name })}
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>

          <div className="lxm-section-title">可以直接播放的曲目（{tracks.length}）</div>
          <div className="lxm-list" style={{ maxHeight: 140 }}>
            {tracks.length === 0 ? (
              <div className="lxm-empty">还没有确认过可播放的曲目。</div>
            ) : (
              tracks.map((t) => (
                <div className="lxm-row" key={`${t.source}:${t.id}`}>
                  <div className="lxm-row-main">
                    <div className="lxm-row-name">{t.title}</div>
                    <div className="lxm-row-sub">
                      {t.artist} · {t.source} · 权重 {t.score.toFixed(2)}
                    </div>
                  </div>
                  <span className="lxm-badge lxm-badge-gray">{t.status === 'played' ? '听过' : '只确认过'}</span>
                </div>
              ))
            )}
          </div>
          {snapshot.tasteNotice ? <div className="lxm-field-hint">{snapshot.tasteNotice}</div> : null}
        </div>
      ) : null}

      {tab === 'evidence' ? (
        <div className="lxm-panel">
          <div className="lxm-field-hint">画像的每一条结论都来自下面这些记录（最近的在前）。</div>
          <div className="lxm-list">
            {events.length === 0 ? (
              <div className="lxm-empty">还没有记录。</div>
            ) : (
              events.map((e, i) => (
                <div className="lxm-row" key={`${e.ts}-${i}`} style={{ cursor: 'default' }}>
                  <div className="lxm-row-main">
                    <div className="lxm-row-name">
                      {e.title ? `${e.title} - ${e.artist}` : e.kind}
                      <span className="lxm-badge lxm-badge-gray">
                        {e.mode === 'explore' ? '探索' : e.origin === 'ai' ? 'AI' : '我'}
                      </span>
                    </div>
                    <div className="lxm-row-sub">
                      {formatTime(e.ts)}
                      {e.playedRatio !== undefined ? ` · 播放 ${Math.round(e.playedRatio * 100)}%` : ''}
                      {e.reasons.length > 0 ? ` · ${e.reasons.join('；')}` : ''}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      ) : null}

      {tab === 'settings' ? (
        <div className="lxm-panel">
          <div className="lxm-settings-grid">
            <div className="lxm-switch-row">
              <div>
                <div className="lxm-field-label">记录我的音乐口味</div>
                <div className="lxm-field-hint">关闭后立刻停止记录（不需要重启），已有数据仍然保留。</div>
              </div>
              <button
                className="lxm-switch"
                data-on={config?.enabled ?? false}
                disabled={busy}
                onClick={() => void store.setMemoryConfig({ enabled: !(config?.enabled ?? false) })}
              />
            </div>

            <div className="lxm-field">
              <div className="lxm-field-label">口味半衰期（越短越跟得上最近的变化）</div>
              <select
                className="lxm-select"
                value={String(config?.halfLifeDays ?? 90)}
                onChange={(e) => void store.setMemoryConfig({ halfLifeDays: Number(e.target.value) })}
              >
                {[30, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} 天
                  </option>
                ))}
              </select>
            </div>

            <div className="lxm-field">
              <div className="lxm-field-label">原始记录保留期</div>
              <select
                className="lxm-select"
                value={String(config?.retainDays ?? 90)}
                onChange={(e) => void store.setMemoryConfig({ retainDays: Number(e.target.value) })}
              >
                {[30, 90, 180, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} 天
                  </option>
                ))}
              </select>
              <div className="lxm-field-hint">聚合后的口味画像不受影响，只影响"证据"能回溯多久。</div>
            </div>

            <div className="lxm-field">
              <div className="lxm-field-label">提供给 AI 的画像详细度</div>
              <select
                className="lxm-select"
                value={config?.budget ?? 'balanced'}
                onChange={(e) => void store.setMemoryConfig({ budget: e.target.value })}
              >
                {Object.entries(BUDGET_LABEL).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="lxm-field">
              <div className="lxm-field-label">探索比例（推荐没听过的歌的概率）</div>
              <select
                className="lxm-select"
                value={String(config?.exploreRatio ?? 0.2)}
                onChange={(e) => void store.setMemoryConfig({ exploreRatio: Number(e.target.value) })}
              >
                {[0, 0.1, 0.2, 0.35].map((r) => (
                  <option key={r} value={r}>
                    {Math.round(r * 100)}%
                  </option>
                ))}
              </select>
              <div className="lxm-field-hint">探索失败时对艺人的负反馈会大幅打折，避免把新艺人一次性压死。</div>
            </div>

            {taste?.exploreStats ? (
              <div className="lxm-field-hint">
                复听：{taste.exploreStats.replayPlays} 次听完 / {taste.exploreStats.replaySkips} 次切走；
                探索：{taste.exploreStats.explorePlays} 次听完 / {taste.exploreStats.exploreSkips} 次切走。
              </div>
            ) : null}

            <div className="lxm-section-title">数据</div>
            <div className="lxm-field-hint">全部保存在本机 <code>$DSH_HOME/storages</code>，不上传。</div>
            {confirmClear ? (
              <div className="lxm-toolbar">
                <span className="lxm-field-hint">确定清空全部画像数据？</span>
                <button
                  className="lxm-search-btn"
                  disabled={busy}
                  onClick={() => {
                    void store.tasteAction({ action: 'clear' }).then(() => setConfirmClear(false))
                  }}
                >
                  确定清空
                </button>
                <button className="lxm-btn" onClick={() => setConfirmClear(false)}>
                  取消
                </button>
              </div>
            ) : (
              <button className="lxm-btn" disabled={busy} onClick={() => setConfirmClear(true)}>
                清空全部画像数据
              </button>
            )}
          </div>
          {snapshot.tasteNotice ? <div className="lxm-field-hint">{snapshot.tasteNotice}</div> : null}
        </div>
      ) : null}
    </Window>
  )
}
