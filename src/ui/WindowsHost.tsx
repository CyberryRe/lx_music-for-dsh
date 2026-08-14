// 窗口渲染桥：主窗口与设置窗口的挂载点（通过 store 开关状态控制显隐）。
// 与侧边栏卡片共享同一 store 实例，保证两端状态一致。

import { useEffect, useState } from 'react'
import type { LxStore } from './store'
import { LxMainWindow } from './MainWindow'
import { LxSettingsWindow } from './SettingsWindow'
import { DraggableWindow } from './Modal'

export interface WindowsHostProps {
  store: LxStore
}

export function WindowsHost(props: WindowsHostProps): JSX.Element {
  const { store } = props
  const [open, setOpen] = useState<{ main: boolean; settings: boolean }>(() => {
    const s = store.getSnapshot()
    return { main: s.mainOpen, settings: s.settingsOpen }
  })

  useEffect(() => {
    return store.subscribe(() => {
      const s = store.getSnapshot()
      setOpen({ main: s.mainOpen, settings: s.settingsOpen })
    })
  }, [store])

  return (
    <>
      {open.main && <LxMainWindow store={store} Window={DraggableWindow} />}
      {open.settings && <LxSettingsWindow store={store} Window={DraggableWindow} />}
    </>
  )
}
