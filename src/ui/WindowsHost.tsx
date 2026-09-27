// 窗口渲染桥：主窗口、设置窗口与「我的口味」窗口的挂载点（通过 store 开关状态控制显隐）。
// 与侧边栏卡片共享同一 store 实例，保证两端状态一致。

import { useEffect, useState } from 'react'
import type { LxStore } from './store'
import { LxMainWindow } from './MainWindow'
import { LxSettingsWindow } from './SettingsWindow'
import { LxTasteWindow } from './TasteWindow'
import { DraggableWindow } from './Modal'

export interface WindowsHostProps {
  store: LxStore
}

export function WindowsHost(props: WindowsHostProps): JSX.Element {
  const { store } = props
  const [open, setOpen] = useState<{ main: boolean; settings: boolean; taste: boolean }>(() => {
    const s = store.getSnapshot()
    return { main: s.mainOpen, settings: s.settingsOpen, taste: s.tasteOpen }
  })

  useEffect(() => {
    return store.subscribe(() => {
      const s = store.getSnapshot()
      setOpen({ main: s.mainOpen, settings: s.settingsOpen, taste: s.tasteOpen })
    })
  }, [store])

  return (
    <>
      {open.main && <LxMainWindow store={store} Window={DraggableWindow} />}
      {open.settings && <LxSettingsWindow store={store} Window={DraggableWindow} />}
      {open.taste && <LxTasteWindow store={store} Window={DraggableWindow} />}
    </>
  )
}
