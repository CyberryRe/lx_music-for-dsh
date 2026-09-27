// 存储键 → 文件名的安全映射。
//
// 为什么必须有这一层（1.2.0 在桌面版实测踩到的真问题）：
//   domain 从 `single` 换成 `per-record` 后，**表的键会直接变成文件名**。
//   本插件的键大量含非法字符：
//     - `logs` 表用 ISO 时间戳当键（`2026-09-11T03:47:40.052Z`，含冒号）；
//     - 画像表用 `曲名|艺人` / `platform:tx` / `mood:frustrated@artist:…` 这类复合键。
//   后端的 per-record 单元要求键匹配 **`/^[a-zA-Z0-9_-]+$/`**（写入时明确报
//   `per-record key '…' is not path-safe`）；而它的 legacy bootstrap 连这个校验都不做，
//   直接按原始键写文件，于是 Windows 上以
//   `ENOENT: rename '….tmp' -> '…2026-09-11T03:47:40.052Z.json'` 失败、整个 open() 抛错
//   → 插件静默退化成内存存储（播放列表/画像全都不落盘）。
//
// 映射规则（要求文件名安全 + **单射** + 长度受控）：
//   1. 已经是安全形态的键（`^[a-zA-Z0-9][a-zA-Z0-9-]*$`，即不含下划线）**原样使用**：
//      日期键 `2026-09-11`、`order`、`summary` 等人类可读；
//   2. 其余一律编码成 `_` 前缀 + 逐字节转义（`_` → `_5f`，其它非安全字节 → `_xx` 十六进制）。
//      由于直通分支**不可能**以下划线开头，两个分支天然互斥 → 映射单射；
//   3. 编码后过长时截断并附内容哈希（哈希保证唯一性），仍然保持 `_` 前缀。

import { createHash } from 'node:crypto'

/** 直通形态：首位字母数字、其余仅字母数字与连字符（不含下划线，保证与编码分支互斥）。 */
const PASSTHROUGH = /^[a-zA-Z0-9][a-zA-Z0-9-]*$/

/** 安全字符（可直接落在文件名里）。 */
const SAFE_BYTE = /[a-zA-Z0-9-]/

/** 文件名长度上限（后端还要加 `.json`）。 */
const MAX_KEY_LENGTH = 96

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 16)
}

/**
 * 把任意字符串键映射成 per-record 布局可用的安全键。
 *
 * 例：
 *   `2026-09-11`              → `2026-09-11`（直通）
 *   `2026-09-11T03:47:40.052Z` → `_2026-09-11T03_3a47_3a40_2e052Z`
 *   `platform:tx`             → `_platform_3atx`
 *   `晴天|周杰伦`              → `_e699b4_e5a4a9_7c_e591a8_e69db0_e4bca6`
 *   `AC/DC`                   → `_AC_2fDC`
 */
export function storageKey(raw: string): string {
  const key = String(raw ?? '')
  if (key.length > 0 && key.length <= MAX_KEY_LENGTH && PASSTHROUGH.test(key)) return key

  let out = '_'
  for (const byte of Buffer.from(key, 'utf8')) {
    const ch = String.fromCharCode(byte)
    out += SAFE_BYTE.test(ch) ? ch : `_${byte.toString(16).padStart(2, '0')}`
  }
  if (out.length <= MAX_KEY_LENGTH) return out
  // 超长：保留前缀 + 内容哈希（前缀已含 `_`，不破坏分支互斥）
  return `${out.slice(0, MAX_KEY_LENGTH - 17)}_${shortHash(key)}`
}

/** 键是否已经可以直接当文件名用（诊断用）。 */
export function isSafeStorageKey(key: string): boolean {
  return key.length > 0 && key.length <= MAX_KEY_LENGTH && /^[a-zA-Z0-9_-]+$/.test(key)
}
