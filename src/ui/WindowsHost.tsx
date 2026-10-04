// 窗口渲染桥：主窗口、设置窗口、「我的口味」窗口与歌词窗口的挂载点（通过 store 开关状态控制显隐）。
// 与侧边栏卡片共享同一 store 实例，保证两端状态一致。

import { useSyncExternalStore } from 'react'
import type { LxStore } from './store'
import { LxMainWindow } from './MainWindow'
import { LxSettingsWindow } from './SettingsWindow'
import { LxTasteWindow } from './TasteWindow'
import { LxLyricsWindow } from './LyricsWindow'
import { DraggableWindow } from './Modal'

export interface WindowsHostProps {
  store: LxStore
}

export function WindowsHost(props: WindowsHostProps): JSX.Element {
  const { store } = props
  // 与 Card / MainWindow / SettingsWindow / TasteWindow 用同一种订阅方式（store 是外部可变源）。
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot)

  return (
    <>
      {snapshot.mainOpen && <LxMainWindow store={store} Window={DraggableWindow} />}
      {snapshot.settingsOpen && <LxSettingsWindow store={store} Window={DraggableWindow} />}
      {snapshot.tasteOpen && <LxTasteWindow store={store} Window={DraggableWindow} />}
      {snapshot.lyricsOpen && <LxLyricsWindow store={store} Window={DraggableWindow} />}
    </>
  )
}
