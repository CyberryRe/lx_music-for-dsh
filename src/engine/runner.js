// 音源脚本子进程（runner）：每个已启用音源脚本一个独立子进程。
// 由 host 侧 sandbox.ts spawn(process.execPath, [runnerPath]) 启动，IPC 通信。
//
// 安全模型（本插件安全复核的核心修复）：
// - 子进程 = 隔离边界。第三方音源脚本（不可信代码）只能在本进程内执行；
//   即使其逃逸 node:vm（如 Buffer.constructor('return process')）也只能拿到
//   本子进程的 process —— 读不到 DSH 宿主进程的内存/句柄/环境变量。
// - 子进程环境由父进程白名单注入（仅 NODE_ENV/系统路径/代理变量），不含任何 DSH 机密。
// - 网络请求（lx.request）带 SSRF 防护：默认拦截私网/回环/链路本地等地址，
//   防止脚本探测内网与 DSH 自身（127.0.0.1:3080）。
// - 脚本的 uncaughtException / unhandledRejection / 死循环只会影响本子进程
//   （超时由父进程杀进程兜底），宿主进程不受影响。
//
// 注意：本文件不使用模板字符串/`${}`，保持纯 CJS，可被 tsc(allowJs) 与 rollup 直接产出。

'use strict'

const vm = require('node:vm')
const http = require('node:http')
const https = require('node:https')
const dns = require('node:dns')
const net = require('node:net')
const crypto = require('node:crypto')
const zlib = require('node:zlib')

const DEFAULT_TIMEOUT_MS = 15000
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024
const MAX_REDIRECTS = 5
// 退出前小延迟：让排队中的 IPC 消息（日志/结果）先送达父进程再退出
const FLUSH_MS = 120

// ── 网络策略（SSRF 防护）────────────────────────────────────────────────────
// 拦截：私网/回环/链路本地/CGNAT/保留/组播地址（IPv4 与 IPv6，含 IPv4 映射）。
// 注意：Node 的 BlockList 对 IPv6 条目必须显式传 type（'ipv6'），否则抛 Invalid socket address。
const TYPE_V4 = 'ipv4'
const TYPE_V6 = 'ipv6'
const blockList = new net.BlockList()
blockList.addSubnet('0.0.0.0', 8, TYPE_V4)
blockList.addSubnet('10.0.0.0', 8, TYPE_V4)
blockList.addSubnet('100.64.0.0', 10, TYPE_V4)
blockList.addSubnet('127.0.0.0', 8, TYPE_V4)
blockList.addSubnet('169.254.0.0', 16, TYPE_V4)
blockList.addSubnet('172.16.0.0', 12, TYPE_V4)
blockList.addSubnet('192.0.0.0', 24, TYPE_V4)
blockList.addSubnet('192.168.0.0', 16, TYPE_V4)
blockList.addSubnet('198.18.0.0', 15, TYPE_V4)
blockList.addSubnet('224.0.0.0', 4, TYPE_V4)
blockList.addSubnet('240.0.0.0', 4, TYPE_V4)
blockList.addAddress('::1', TYPE_V6)
blockList.addSubnet('fc00::', 7, TYPE_V6)
blockList.addSubnet('fe80::', 10, TYPE_V6)

/** IPv4 映射地址（::ffff:x.x.x.x）按内嵌 IPv4 判定。 */
function normalizeIp(ip) {
  const lower = String(ip).toLowerCase()
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  return mapped ? mapped[1] : lower
}

function isBlockedIp(ip) {
  const normalized = normalizeIp(ip)
  const type = net.isIP(normalized) === 6 ? TYPE_V6 : TYPE_V4
  try {
    return blockList.check(normalized, type)
  } catch (_e) {
    return false
  }
}

/** 校验 URL 是否允许访问。返回 { error? }。allowPrivate=true 时跳过地址检查。 */
function checkUrl(url, allowPrivate) {
  let parsed
  try {
    parsed = new URL(url)
  } catch (_e) {
    return { error: 'URL 格式无效' }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: '仅允许 http/https 协议' }
  }
  if (allowPrivate) return {}
  const host = parsed.hostname
  if (net.isIP(host)) {
    if (isBlockedIp(host)) return { error: '访问被网络策略拦截（内网/本机地址）' }
    return {}
  }
  // 域名：解析后只要任一地址命中拦截即拒绝（覆盖 DNS 重绑定常见形态）
  let blocked = false
  try {
    const addrs = dns.lookupSync(host, { all: true })
    blocked = addrs.some((a) => isBlockedIp(a.address))
  } catch (_e) {
    blocked = false // 解析失败留给连接阶段报错
  }
  if (blocked) return { error: '访问被网络策略拦截（解析到内网/本机地址）' }
  return {}
}

// ── 通用工具 ────────────────────────────────────────────────────────────────

function toBuffer(value) {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return Buffer.from(copy.buffer)
}

/** 跨 vm 上下文结果清理（JSON 化，切断 Proxy 链）。 */
function decontextify(value) {
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(decontextify)
  try {
    return JSON.parse(JSON.stringify(value))
  } catch (_e) {
    return String(value)
  }
}

function safeString(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.stack || value.message
  try {
    return JSON.stringify(value)
  } catch (_e) {
    return String(value)
  }
}

/** 子进程日志转发到父进程（父进程聚合到宿主 stdout 并写请求日志）。 */
function forwardConsole(level) {
  return function (...args) {
    try {
      const text = args.map((a) => safeString(a)).join(' ')
      process.send({ type: 'console', level: level || 'log', text })
    } catch (_e) {
      // 父进程已断开：忽略
    }
  }
}

function pushLog(entry) {
  try {
    process.send({
      type: 'httplog',
      url: entry.url,
      statusCode: entry.statusCode,
      error: entry.error,
      ms: entry.ms,
    })
  } catch (_e) {
    // 父进程已断开：忽略
  }
}

function urlencodeForm(data) {
  return Object.entries(data)
    .map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v)))
    .join('&')
}

// ── lx.request（回调风格 + SSRF 防护 + 重定向 + 超时 + 大小上限）──────────────

function lxRequest(url, options, callback) {
  if (typeof options === 'function') {
    callback = options
    options = {}
  }
  options = options || {}
  if (typeof callback !== 'function') callback = function noop() {}
  const startedAt = Date.now()
  const policy = checkUrl(url, allowPrivate)
  if (policy.error) {
    const err = new Error(policy.error + ' (' + url + ')')
    pushLog({ url: String(url), error: err.message, ms: Date.now() - startedAt })
    setTimeout(function () { callback(err) }, 0)
    return function cancel() { /* 已被策略拦截，无需取消 */ }
  }
  return doRequest(url, options, callback, 0, startedAt)
}

function doRequest(url, options, callback, redirects, startedAt) {
  const method = (options.method || 'get').toLowerCase()
  const timeout = options.timeout || DEFAULT_TIMEOUT_MS
  const headers = Object.assign({}, options.headers)
  let body
  if (options.form || options.formData) {
    body = urlencodeForm(options.form || options.formData)
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
  } else if (typeof options.body === 'string') {
    body = options.body
  } else if (options.body !== undefined) {
    body = JSON.stringify(options.body)
    if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
  }

  const transport = String(url).startsWith('https:') ? https : http
  const req = transport.request(url, { method, headers }, function (res) {
    const chunks = []
    let size = 0
    let aborted = false
    res.on('data', function (c) {
      size += c.length
      if (size > MAX_RESPONSE_BYTES) {
        aborted = true
        req.destroy(new Error('响应体超过大小上限 (' + MAX_RESPONSE_BYTES + ' bytes)'))
        return
      }
      chunks.push(c)
    })
    res.on('end', function () {
      if (aborted) return
      let raw = Buffer.concat(chunks)
      const encoding = String(res.headers['content-encoding'] || '').toLowerCase()
      try {
        if (encoding === 'gzip') raw = zlib.gunzipSync(raw)
        else if (encoding === 'deflate') raw = zlib.inflateSync(raw)
      } catch (_e) {
        // 解压失败时保留原始内容
      }

      // 重定向：先校验目标再跟随（最多 MAX_REDIRECTS 跳）
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        if (redirects >= MAX_REDIRECTS) {
          const err = new Error('重定向次数超过上限 (' + MAX_REDIRECTS + ')')
          pushLog({ url: String(url), statusCode: res.statusCode, error: err.message, ms: Date.now() - startedAt })
          callback(err)
          return
        }
        let next
        try {
          next = new URL(res.headers.location, url).href
        } catch (_e2) {
          next = String(res.headers.location)
        }
        const policy = checkUrl(next, allowPrivate)
        if (policy.error) {
          const err = new Error(policy.error + ' (重定向目标 ' + next + ')')
          pushLog({ url: String(url), statusCode: res.statusCode, error: err.message, ms: Date.now() - startedAt })
          callback(err)
          return
        }
        doRequest(next, Object.assign({}, options, { headers }), callback, redirects + 1, startedAt)
        return
      }

      let parsed = raw.toString('utf8')
      if ((options.responseType || 'json') === 'json') {
        try {
          parsed = JSON.parse(raw.toString('utf8'))
        } catch (_e3) {
          parsed = raw.toString('utf8')
        }
      }
      pushLog({ url: String(url), statusCode: res.statusCode, ms: Date.now() - startedAt })
      const safeResp = { statusCode: res.statusCode, statusMessage: res.statusMessage, headers: res.headers, body: parsed }
      try {
        callback(null, safeResp, parsed)
      } catch (err) {
        forwardConsole('warn')('lx.request 回调抛错（已隔离）:', err && err.message)
      }
    })
    res.on('error', function (err) {
      pushLog({ url: String(url), error: err.message, ms: Date.now() - startedAt })
      try {
        callback(err)
      } catch (e2) {
        forwardConsole('warn')('lx.request 错误回调抛错（已隔离）:', e2 && e2.message)
      }
    })
  })
  req.on('error', function (err) {
    pushLog({ url: String(url), error: err.message, ms: Date.now() - startedAt })
    try {
      callback(err)
    } catch (e2) {
      forwardConsole('warn')('lx.request 错误回调抛错（已隔离）:', e2 && e2.message)
    }
  })
  req.setTimeout(timeout, function () {
    req.destroy(new Error('timeout (' + timeout + 'ms)'))
  })
  if (body !== undefined) req.write(body)
  req.end()
  return function cancel() {
    try {
      req.destroy()
    } catch (_e4) {
      // 已结束
    }
  }
}

// ── lx.utils ────────────────────────────────────────────────────────────────

function makeUtils() {
  return {
    buffer: {
      from: function (d, e) {
        return typeof d === 'string' ? Buffer.from(d, e) : toBuffer(d)
      },
      bufToString: function (b, f) {
        return typeof b === 'string' ? b : toBuffer(b).toString(f)
      },
    },
    crypto: {
      md5: function (str) {
        return crypto.createHash('md5').update(String(str || '')).digest('hex')
      },
      aesEncrypt: function (buffer, mode, key, iv) {
        const cipher = crypto.createCipheriv(mode, toBuffer(key), toBuffer(iv))
        return Buffer.concat([cipher.update(toBuffer(buffer)), cipher.final()])
      },
      rsaEncrypt: function (buffer, key) {
        return crypto.publicEncrypt(key, toBuffer(buffer))
      },
      randomBytes: function (size) {
        return crypto.randomBytes(size)
      },
    },
    zlib: {
      inflate: function (buffer) {
        return new Promise(function (resolve, reject) {
          zlib.inflate(toBuffer(buffer), function (err, out) {
            if (err) reject(err)
            else resolve(out)
          })
        })
      },
      deflate: function (buffer) {
        return new Promise(function (resolve, reject) {
          zlib.deflate(toBuffer(buffer), function (err, out) {
            if (err) reject(err)
            else resolve(out)
          })
        })
      },
    },
  }
}

// ── 沙箱环境（vm 上下文；真正隔离边界是"本子进程"）──────────────────────────

function safeTimer(fn) {
  return function (...args) {
    try {
      return fn(...args)
    } catch (err) {
      forwardConsole('warn')('音源脚本定时器回调抛错（已隔离）:', err && err.message)
    }
  }
}

function buildSandbox(lxApi) {
  const sandbox = {
    console: {
      log: forwardConsole('log'),
      info: forwardConsole('info'),
      debug: forwardConsole('debug'),
      warn: forwardConsole('warn'),
      error: forwardConsole('error'),
    },
    setTimeout: function (fn, ms) {
      const args = Array.prototype.slice.call(arguments, 2)
      return setTimeout(safeTimer(fn), ms, ...args)
    },
    clearTimeout: clearTimeout,
    setInterval: function (fn, ms) {
      const args = Array.prototype.slice.call(arguments, 2)
      return setInterval(safeTimer(fn), ms, ...args)
    },
    clearInterval: clearInterval,
    Buffer: Buffer,
    URL: URL,
    URLSearchParams: URLSearchParams,
    TextEncoder: TextEncoder,
    TextDecoder: TextDecoder,
    atob: function (s) { return Buffer.from(s, 'base64').toString('binary') },
    btoa: function (s) { return Buffer.from(s, 'binary').toString('base64') },
    crypto: {
      getRandomValues: function (arr) { return crypto.randomFillSync(arr) },
    },
    process: {
      nextTick: function (fn) { setTimeout(safeTimer(fn), 0) },
      env: { NODE_ENV: 'production' },
    },
    lx: lxApi,
  }
  sandbox.global = sandbox
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  return sandbox
}

// ── 状态与主循环 ────────────────────────────────────────────────────────────

let allowPrivate = false
let currentId = 'unknown'
let initTimeoutMs = 10000
let requestHandler = null
let registeredSources = {}
let initTimer = null
let initSettled = false

function exitSoon(code) {
  setTimeout(function () { process.exit(code) }, FLUSH_MS)
}

function sendInitResult(ok, sources, error) {
  try {
    process.send({ type: 'init-result', ok, sources, error })
  } catch (_e) {
    // 父进程已断开
  }
}

function finishInit(ok) {
  if (initSettled) return
  initSettled = true
  clearTimeout(initTimer)
  if (ok) sendInitResult(true, registeredSources, undefined)
  else sendInitResult(false, undefined, '未调用 lx.send("inited")')
  if (!ok) exitSoon(0)
}

function initFail(message) {
  if (initSettled) return
  initSettled = true
  clearTimeout(initTimer)
  sendInitResult(false, undefined, message)
  exitSoon(0)
}

function buildLxApi(scriptText, metadata) {
  const lxApi = {
    version: '2.0.0',
    env: 'desktop',
    platform: 'web',
    currentScriptInfo: {
      name: (metadata && metadata.name) || currentId,
      description: (metadata && metadata.description) || '',
      version: (metadata && metadata.version) || '1.0.0',
      author: (metadata && metadata.author) || '',
      homepage: (metadata && metadata.homepage) || '',
      rawScript: scriptText,
    },
    EVENT_NAMES: {
      request: 'request',
      inited: 'inited',
      updateAlert: 'updateAlert',
    },
    utils: makeUtils(),
    request: lxRequest,
    send: function (eventName, data) {
      const dData = decontextify(data)
      if (eventName === 'inited') {
        if (dData && dData.sources) registeredSources = dData.sources
        finishInit(true)
      }
      // updateAlert 等事件：记录但不阻断
    },
    on: function (eventName, handler) {
      if (eventName === 'request') requestHandler = handler
    },
  }
  return lxApi
}

function handleInit(msg) {
  currentId = msg.id
  initTimeoutMs = msg.initTimeoutMs || 10000
  allowPrivate = msg.allowPrivate === true
  const script = String(msg.script || '')
  const lxApi = buildLxApi(script, msg.metadata)
  const sandbox = buildSandbox(lxApi)
  let context
  try {
    context = vm.createContext(sandbox)
  } catch (err) {
    initFail('沙箱创建失败: ' + (err && err.message))
    return
  }
  initTimer = setTimeout(function () {
    if (!initSettled) initFail('初始化超时（> ' + initTimeoutMs + 'ms，未调用 lx.send("inited")）')
  }, initTimeoutMs)
  try {
    vm.runInContext(script, context, { filename: 'source_' + currentId + '.js', timeout: initTimeoutMs })
  } catch (err) {
    initFail('执行失败: ' + (err && err.message))
  }
  // runInContext 同步执行完毕；等待脚本 lx.send('inited') 或 initTimer
}

function handleCall(msg) {
  const respond = function (payload) {
    try {
      process.send({ type: 'call-result', callId: msg.callId, ok: !!payload.ok, value: payload.value, error: payload.error })
    } catch (_e) {
      // 父进程已断开
    }
  }
  if (typeof requestHandler !== 'function') {
    respond({ ok: false, error: { message: '音源未注册 request 处理器' } })
    return
  }
  const input = { action: msg.action, source: msg.source, info: msg.info }
  let result
  try {
    result = requestHandler(input)
  } catch (err) {
    respond({ ok: false, error: { message: err && err.message ? err.message : String(err) } })
    return
  }
  Promise.resolve(result).then(
    function (value) {
      respond({ ok: true, value: decontextify(value) })
    },
    function (err) {
      respond({ ok: false, error: { message: err && err.message ? err.message : String(err) } })
    },
  )
}

process.on('message', function (msg) {
  if (!msg || typeof msg !== 'object') return
  try {
    if (msg.type === 'init') handleInit(msg)
    else if (msg.type === 'call') handleCall(msg)
    else if (msg.type === 'shutdown') process.exit(0)
  } catch (err) {
    forwardConsole('error')('runner 处理消息失败:', err && err.message)
  }
})

// 宿主进程退出/IPC 通道关闭 → 本进程自清理退出（避免孤儿进程）
process.on('disconnect', function () {
  process.exit(0)
})

// 最后一层兜底：脚本的异步错误只影响本子进程（随进程退出），绝不波及宿主进程
process.on('uncaughtException', function (err) {
  forwardConsole('error')('音源脚本未捕获异常（子进程将退出，宿主不受影响）:', err && (err.stack || err.message))
  exitSoon(1)
})

process.on('unhandledRejection', function (reason) {
  forwardConsole('error')('音源脚本未处理的 Promise 拒绝（子进程将退出，宿主不受影响）:', reason && (reason.stack || reason.message))
  exitSoon(1)
})