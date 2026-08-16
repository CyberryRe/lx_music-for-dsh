// 播放模式 UI 元数据：图标/文案/循环顺序（单曲循环 ↔ 随机 ↔ 顺序 ↔ 列表循环）。
// 图标使用单色文本符号（与 ⏮⏭☰⚙ 风格一致），避免彩色 emoji 与整体 UI 冲突。

import type { PlayMode } from '../shared/types'

export interface PlayModeMeta {
  value: PlayMode
  icon: string
  label: string
}

/** 四种播放模式（循环切换顺序与 LX Music 一致）。 */
export const PLAY_MODES: PlayModeMeta[] = [
  { value: 'list', icon: '↻', label: '列表循环' },
  { value: 'single', icon: '↻¹', label: '单曲循环' },
  { value: 'shuffle', icon: '⇋', label: '随机播放' },
  { value: 'order', icon: '→', label: '顺序播放' },
]

export const PLAY_MODE_LABEL: Record<PlayMode, string> = {
  list: '列表循环',
  single: '单曲循环',
  shuffle: '随机播放',
  order: '顺序播放',
}

/** 循环切换：列表循环 → 单曲循环 → 随机播放 → 顺序播放 → 列表循环。 */
export function nextPlayMode(mode: PlayMode): PlayMode {
  const idx = PLAY_MODES.findIndex((m) => m.value === mode)
  return PLAY_MODES[(idx + 1) % PLAY_MODES.length]!.value
}
