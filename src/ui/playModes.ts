// 播放模式 UI 元数据：图标/文案/循环顺序（单曲循环 ↔ 随机 ↔ 顺序 ↔ 列表循环）。
// 图标使用单色文本符号（与 ⏮⏭☰⚙ 风格一致），避免彩色 emoji 与整体 UI 冲突。

import type { PlayMode } from '../shared/types'

export interface PlayModeMeta {
  value: PlayMode
  icon: string
  label: string
}

/** 四种播放模式（循环切换顺序与 LX Music 一致；值的全集见 shared/types 的 PLAY_MODE_VALUES）。 */
export const PLAY_MODES: PlayModeMeta[] = [
  { value: 'list', icon: '↻', label: '列表循环' },
  { value: 'single', icon: '↻¹', label: '单曲循环' },
  { value: 'shuffle', icon: '⇋', label: '随机播放' },
  { value: 'order', icon: '→', label: '顺序播放' },
]

/** 播放模式 → 文案（从 PLAY_MODES 派生，避免新增模式时两处不同步）。 */
export const PLAY_MODE_LABEL: Record<PlayMode, string> = Object.fromEntries(
  PLAY_MODES.map((m) => [m.value, m.label]),
) as Record<PlayMode, string>

/** 循环切换：列表循环 → 单曲循环 → 随机播放 → 顺序播放 → 列表循环。 */
export function nextPlayMode(mode: PlayMode): PlayMode {
  const idx = PLAY_MODES.findIndex((m) => m.value === mode)
  return PLAY_MODES[(idx + 1) % PLAY_MODES.length]!.value
}
