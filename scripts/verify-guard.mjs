// 验证子进程隔离边界（安全复核核心性质）：
// 1) 恶意音源脚本即使逃逸 vm（Buffer.constructor('return process')）也只能拿到
//    **子进程**的 process —— 对其 exit/自杀只杀掉子进程，宿主进程不受影响；
//    此时 loadSourceScript 以 init 失败结束，之后沙箱仍可正常加载其他脚本。
// 2) 脚本自身的未捕获异常 / 未处理 Promise 拒绝只让子进程退出，宿主进程存活。
// 用法：node scripts/compile-tests.mjs && node scripts/verify-guard.mjs
// 若隔离失效（逃逸影响宿主），本脚本会崩溃或抛出非预期错误。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { loadSourceScript } = require('../.test-dist/src/engine/sandbox.js')

// 1) 逃逸 + 自杀：在旧 vm-in-host 实现中这会直接拿到宿主 process（RCE 面）；
//    现在只杀子进程。注意 p.exit() 发生在顶层执行期间 → init 报错。
const escapeScript = `
(function () {
  const p = Buffer.constructor('return process')()
  if (p && p.exit) p.exit(7)
})()
lx.send('inited', { sources: { evil: { name: 'evil' } } })
`
try {
  await loadSourceScript('evil', escapeScript, { initTimeoutMs: 4000 })
  console.error('FAIL: 逃逸脚本未被隔离')
  process.exit(1)
} catch (err) {
  console.log('[1] 逃逸尝试被限制在子进程内（init 失败）:', err.message)
}

// 2) 宿主进程存活，且沙箱仍可用
const okScript = `
lx.on('request', () => 'https://example.com/ok.mp3')
lx.send('inited', { sources: { wy: { name: 'wy' } } })
`
const loaded = await loadSourceScript('ok', okScript, { initTimeoutMs: 4000 })
const url = await loaded.call('musicUrl', 'wy', {})
console.log('[2] 逃逸后宿主仍可正常加载/调用:', url)
loaded.dispose()

// 3) 脚本异步未捕获异常只杀子进程，宿主存活
const crashScript = `
setTimeout(() => { throw new TypeError('boom (async)') }, 20)
lx.send('inited', { sources: { ck: { name: 'ck' } } })
`
const loaded2 = await loadSourceScript('crash', crashScript, { initTimeoutMs: 3000 })
await new Promise((resolve) => setTimeout(resolve, 300))
loaded2.dispose()

console.log('OK: 恶意/异常音源脚本已被子进程边界隔离，宿主进程存活')