// 音源健康检查：下载音源脚本 → 沙箱加载 → 用内置 SDK 搜索真实歌曲 → 调用 musicUrl 验证。
// 用法：node scripts/compile-tests.mjs && node scripts/smoke-source.mjs <音源URL> [平台] [关键词]
// 示例：node scripts/smoke-source.mjs https://ghproxy.net/raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js wy 晴天

import { loadSourceScript } from '../.test-dist/src/engine/sandbox.js'
import { normalizeSongInfo } from '../.test-dist/src/engine/musicEngine.js'
import { searchPlatform } from '../.test-dist/src/sdk/index.js'

const url = process.argv[2]
const targetSource = process.argv[3] ?? 'wy'
const keyword = process.argv[4] ?? '晴天 周杰伦'
const quality = process.argv[5] ?? '128k'
if (!url) {
  console.error('用法: node scripts/smoke-source.mjs <音源URL|file:本地路径> [平台] [关键词] [音质]')
  process.exit(1)
}

console.log(`[check] 下载: ${url}`)
const text = url.startsWith('file:')
  ? await import('node:fs/promises').then((fs) => fs.readFile(url.slice(5), 'utf8'))
  : await (await fetch(url)).text()
console.log(`[check] 大小: ${text.length} 字节`)

let loaded
let sources = []
try {
  loaded = await loadSourceScript('smoke.js', text, { initTimeoutMs: 10_000 })
  sources = Object.keys(loaded.sources)
  console.log(`[check] 加载成功，注册平台: ${sources.join(', ')}`)
  if (sources.length === 0) {
    console.log('[check] 脚本未注册任何平台')
    process.exit(1)
  }
} catch (err) {
  console.error(`[check] 加载失败: ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const source = sources.includes(targetSource) ? targetSource : sources[0]
console.log(`[check] 搜索测试歌曲（${source} / ${keyword}）...`)
const songs = await searchPlatform(source, keyword, 1).catch((e) => {
  console.error(`[check] 内置 SDK 搜索失败: ${e.message}`)
  return []
})
if (songs.length === 0) {
  console.error('[check] 没有搜索到歌曲，无法测试解析')
  loaded.dispose()
  process.exit(1)
}
const song = songs[0]
console.log(`[check] 测试歌曲: ${song.name} - ${song.singer} [${song.source}]`)

const t0 = Date.now()
try {
  const result = await loaded.call('musicUrl', source, { musicInfo: normalizeSongInfo(song), quality, type: quality })
  const ok = typeof result === 'string' && result.startsWith('http')
  console.log(`[check] 解析结果: ${ok ? '✅ 成功' : '⚠️ 非直链'}`)
  if (typeof result === 'string') console.log(`[check] URL: ${result.slice(0, 160)}`)
  else console.log(`[check] 返回类型: ${typeof result}`, JSON.stringify(result)?.slice(0, 160))
  console.log(`[check] 耗时: ${Date.now() - t0}ms`)
} catch (err) {
  console.log(`[check] ❌ 解析失败（${Date.now() - t0}ms）: ${err instanceof Error ? err.message : String(err)}`)
  console.log('[check] 提示: 脚本若依赖第三方 API（如 onrender/自建服务器），服务不可达时会解析失败，属于音源问题而非插件问题')
  process.exit(3)
} finally {
  loaded.dispose()
}
