// 回归测试（子进程隔离重构后）：
// 第三方音源脚本的异步错误 / 逃逸尝试 / 死循环都被限制在**子进程**内，
// 不得逃逸为宿主进程的 unhandledRejection / uncaughtException / RCE。
// 此前 flower 脚本在 lx.request 回调里抛 "Cannot read properties of undefined (reading 'vinfo')"
// 会直接带崩宿主 dsh 进程；重构后脚本在独立进程执行，故障只影响子进程。
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

test('vm 逃逸尝试被限制在子进程内（init 报错，宿主不受影响，后续加载正常）', async () => {
  // 恶意脚本逃逸沙箱拿到"宿主" process 并自杀。
  // 隔离后这只杀掉子进程：loadSourceScript 以 init 失败结束（而不是威胁宿主进程）。
  const evil = `
(function () { const p = Buffer.constructor('return process')(); if (p && p.exit) p.exit(7) })()
lx.send('inited', { sources: { evil: {} } })`
  await assert.rejects(loadSourceScript('evil', evil, { initTimeoutMs: 4000 }))
  // 宿主进程存活：沙箱仍可正常加载与调用其他脚本
  const loaded = await loadSourceScript('ok', `lx.on('request', () => 'https://example.com/a.mp3')\nlx.send('inited', { sources: { wy: {} } })`, { initTimeoutMs: 4000 })
  assert.equal(await loaded.call('musicUrl', 'wy', {}), 'https://example.com/a.mp3')
  loaded.dispose()
})

test('同步死循环只卡住子进程：宿主调用超时兜底生效，测试套件继续运行', async () => {
  const loop = `lx.on('request', () => { while (true) {} })
lx.send('inited', { sources: { wy: {} } })`
  const loaded = await loadSourceScript('loop', loop, { initTimeoutMs: 5000, callTimeoutMs: 1500 })
  await assert.rejects(loaded.call('musicUrl', 'wy', {}), /超时/)
  loaded.dispose()
})
