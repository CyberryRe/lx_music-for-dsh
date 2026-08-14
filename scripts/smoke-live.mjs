// 真实网络冒烟：验证内置 SDK 搜索（五平台）。需要网络。
// 用法：node scripts/compile-tests.mjs && node scripts/smoke-live.mjs
import { searchPlatform } from '../.test-dist/src/sdk/index.js'

const sources = ['wy', 'tx', 'kg', 'kw', 'mg']
for (const s of sources) {
  const t0 = Date.now()
  try {
    const list = await searchPlatform(s, '晴天 周杰伦', 3)
    const first = list[0]
    console.log(`[smoke] ${s}: ${list.length} 首, ${Date.now() - t0}ms, 第一首: ${first?.name ?? '-'} - ${first?.singer ?? '-'} [${first?.source ?? '-'}] ${first?.interval ?? ''} 音质: ${(first?.meta.qualitys ?? []).map((q) => q.type).join('/') || '无'}`)
  } catch (err) {
    console.log(`[smoke] ${s}: 失败 - ${err instanceof Error ? err.message : String(err)}`)
  }
}
