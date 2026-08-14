// 验证进程级兜底：音源脚本自身的未捕获 Promise 拒绝（含 source_<id>.js 堆栈标记）
// 必须被 installProcessGuards 拦截，不能把进程带崩。
// 该场景无法在 node:test 下验证（runner 会拦截 unhandledRejection 并强制失败测试），
// 因此作为独立脚本运行：node scripts/verify-guard.mjs
// 若兜底失效，Node 15+ 默认把 unhandledRejection 抛为未捕获异常 → 进程崩溃（非零退出）。
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { loadSourceScript } = require('../.test-dist/src/engine/sandbox.js')

const scriptWithOwnRejection = `
new Promise((resolve, reject) => setTimeout(() => reject(new Error('boom')), 10))
lx.send('inited', { sources: { rej: { name: 'rej' } } })
`

const scriptWithOwnException = `
setTimeout(() => { throw new TypeError('Cannot read properties of undefined (reading \\'success\\')') }, 10)
lx.send('inited', { sources: { ex: { name: 'ex' } } })
`

const loaded = await loadSourceScript('rej', scriptWithOwnRejection, { initTimeoutMs: 3000 })
const loaded2 = await loadSourceScript('ex', scriptWithOwnException, { initTimeoutMs: 3000 })
console.log('loaded:', !!loaded.sources['rej'], !!loaded2.sources['ex'])

// 等异步错误触发并被兜底拦截
await new Promise((resolve) => setTimeout(resolve, 300))
console.log('OK: 进程存活，音源脚本的未处理错误已被隔离（unhandledRejection / uncaughtException）')
loaded.dispose()
loaded2.dispose()
