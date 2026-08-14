// JSON 安全清洗：递归删除对象中的 undefined 属性值。
// 用途：DSH Typert gateway 对 Remote 返回值做 JSON 边界校验（assertJsonValue），
// 嵌套的 undefined 值（如 SDK 歌曲的 meta.hash: undefined）会被拒绝并抛
// "business result failed boundary validation"。所有 Remote 返回路径统一过此清洗。

export function jsonSafe<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (const item of value) {
      if (item === undefined) continue
      out.push(jsonSafe(item))
    }
    return out as T
  }
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue
    out[key] = jsonSafe(v)
  }
  return out as T
}
