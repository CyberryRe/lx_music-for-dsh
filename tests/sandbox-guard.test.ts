// 回归测试：第三方音源脚本的异步错误不得逃逸为宿主进程的 unhandledRejection / uncaughtException。
// 此前 flower 脚本在 lx.request 回调里抛 "Cannot read properties of undefined (reading 'vinfo')"
// 直接把 dsh 进程带崩（fatal load failure）；修复后应被沙箱隔离。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadSourceScript, getSandboxRequestLog } from '../src/engine/sandbox'

const scriptWithBadCallback = `
const L = (url) => {
  lx.request(url, {}, (err, response, body) => {
    // 模拟真实脚本访问未定义字段：U['vinfo'] 为 undefined，取其属性抛 TypeError
    const U = lx.currentScriptInfo
    if (err) return
    const G = { a: { b: { c: 'ok' } } }
    const x = G['a']['b'][U['vinfo']]
    if (x) {}
  })
}
Promise.all([L('http://127.0.0.1:1/1'), L('http://127.0.0.1:1/2')])
  .then(() => {})
  .catch(() => { throw new Error('FAILED') })
lx.send('inited', { sources: { bada: { name: 'bada' } } })
`

const scriptWithOwnRejection = `
new Promise((resolve, reject) => setTimeout(() => reject(new Error('boom')), 10))
lx.send('inited', { sources: { rej: { name: 'rej' } } })
`

const scriptWithBadTimer = `
setTimeout(() => { throw new TypeError('Cannot read properties of undefined (reading \\'success\\')') }, 10)
lx.send('inited', { sources: { tim: { name: 'tim' } } })
`

test('lx.request 回调内抛 TypeError 不逃逸为 unhandledRejection', async () => {
  const loaded = await loadSourceScript('bada', scriptWithBadCallback, { initTimeoutMs: 3000 })
  assert.ok(loaded.sources['bada'])
  loaded.dispose()
})

// 注：脚本自身未捕获 Promise 拒绝的「进程不崩」验证无法在 node:test 下进行
// （test runner 会拦截 unhandledRejection 并强制失败测试），由 scripts/verify-guard.mjs 单独验证。

test('脚本定时器回调抛错被隔离', async () => {
  const loaded = await loadSourceScript('tim', scriptWithBadTimer, { initTimeoutMs: 3000 })
  assert.ok(loaded.sources['tim'])
  await new Promise((resolve) => setTimeout(resolve, 100))
  loaded.dispose()
})

test('lx.request 请求日志（含失败记录）可被诊断读取', async () => {
  const before = getSandboxRequestLog().length
  const loaded = await loadSourceScript('log', scriptWithBadCallback, { initTimeoutMs: 3000 })
  // 等待失败请求（127.0.0.1:1 拒绝连接）写入日志
  await new Promise((resolve) => setTimeout(resolve, 300))
  const entries = getSandboxRequestLog().slice(before)
  assert.ok(entries.length >= 2, `期望至少 2 条请求日志，实际 ${entries.length}`)
  assert.ok(entries.every((e) => typeof e.url === 'string' && e.url.startsWith('http')))
  assert.ok(entries.some((e) => e.error !== undefined || e.statusCode !== undefined))
  loaded.dispose()
})
