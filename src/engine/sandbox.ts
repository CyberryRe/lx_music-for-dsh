// 音源脚本沙箱：用 node:vm 执行 lx-music-desktop 格式的音源脚本（.js）。
// 协议（与 lxserver userApi.ts / lx-music-desktop 一致）：
//   - 脚本通过 lx.send('inited', { sources: {...} }) 注册支持的平台（初始化超时 10s）
//   - lx.on('request', handler) 注册请求处理器；handler({action, source, info}) 返回结果
//   - action='musicUrl'：info={musicInfo, quality, type}，返回直链字符串
//   - lx.request(url, options, callback) 提供网络能力（callback 风格）
// 安全：vm.createContext 隔离 + 超时 + 结果 JSON 化（decontextify），不暴露 Node 内部。

import * as vm from 'node:vm'
import * as crypto from 'node:crypto'
import * as zlib from 'node:zlib'
import { httpFetch, type HttpFetchOptions, type HttpFetchResult } from '../sdk/request'

export interface SourceRegistration {
  name?: string
  type?: string
  actions?: string[]
  qualitys?: string[]
}

export interface LoadedSourceScript {
  id: string
  name: string
  version?: string
  author?: string
  description?: string
  homepage?: string
  /** 注册的平台 → 声明。 */
  sources: Record<string, SourceRegistration>
  /** 调用脚本请求处理器。 */
  call(action: string, source: string, info: unknown): Promise<unknown>
  dispose(): void
}

export interface SandboxOptions {
  /** 脚本初始化超时（等待 lx.send('inited')）。 */
  initTimeoutMs?: number
  /** 单次请求调用超时。 */
  callTimeoutMs?: number
}

export class SourceScriptError extends Error {
  readonly stage: 'init' | 'call' | 'validate'
  constructor(stage: SourceScriptError['stage'], message: string) {
    super(message)
    this.name = 'SourceScriptError'
    this.stage = stage
  }
}

/** 跨上下文对象清理（切断 Proxy 链，JSON 化）。 */
function decontextify(value: unknown): unknown {
  if (value === null || value === undefined || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => decontextify(v))
  try {
    return JSON.parse(JSON.stringify(value))
  } catch {
    return String(value)
  }
}

/** Uint8Array/Buffer → Buffer（跨 vm 上下文的 Buffer 需要复制，避免原型链问题）。 */
function toBuffer(value: Uint8Array | Buffer): Buffer {
  if (Buffer.isBuffer(value)) return Buffer.from(value)
  const copy = new Uint8Array(value.byteLength)
  copy.set(value)
  return Buffer.from(copy.buffer)
}

/**
 * 进程级兜底：拦截从音源脚本逃逸的未处理错误（unhandledRejection / uncaughtException），
 * 避免第三方脚本的异步错误（如 lx.request 回调里抛 TypeError、脚本自身 Promise 链
 * 未捕获的 rejection）把宿主 DSH 进程带崩。
 * 判定依据：脚本在 vm.runInContext 中以 filename=`source_<id>.js` 执行，错误堆栈必然包含
 * 该标记；不匹配的错误保持 Node 默认行为（还原后重新抛出），不掩盖宿主自身的问题。
 */
let processGuardsInstalled = false
function installProcessGuards(): void {
  if (processGuardsInstalled) return
  processGuardsInstalled = true

  const fromSourceScript = (reason: unknown): boolean => {
    const stack = reason instanceof Error ? (reason.stack ?? '') : String(reason)
    return /source_[A-Za-z0-9_-]+\.js/.test(stack)
  }

  const rejectionGuard = (reason: unknown): void => {
    if (fromSourceScript(reason)) {
      console.warn('[lx-music sandbox] 已拦截音源脚本未处理的 Promise 拒绝（不影响宿主进程）:', reason)
      return
    }
    // 非音源脚本错误：还原默认行为（Node 默认把无处理的 rejection 抛出为 uncaughtException）
    process.removeListener('unhandledRejection' as never, rejectionGuard)
    process.emit('unhandledRejection' as never, reason as never)
    process.on('unhandledRejection' as never, rejectionGuard)
  }
  process.on('unhandledRejection' as never, rejectionGuard)

  const exceptionGuard = (err: Error): void => {
    if (fromSourceScript(err)) {
      console.warn('[lx-music sandbox] 已拦截音源脚本未捕获异常（不影响宿主进程）:', err)
      return
    }
    // 非音源脚本错误：还原默认崩溃行为
    process.removeListener('uncaughtException' as never, exceptionGuard)
    throw err
  }
  process.on('uncaughtException' as never, exceptionGuard)
}

/** 包一层 try/catch，防止沙箱脚本的异步回调抛错逃逸到宿主事件循环。 */
function safeTimer<T extends (...args: never[]) => void>(fn: T): T {
  return ((...args: never[]) => {
    try {
      return fn(...args)
    } catch (err) {
      console.warn('[lx-music sandbox] 音源脚本定时器回调抛错（已隔离）:', err)
    }
  }) as T
}

/** 从脚本头部 JSDoc 注释提取元数据。 */
export function extractScriptMetadata(script: string): { name?: string; description?: string; version?: string; author?: string; homepage?: string } {
  const meta: Record<string, string> = {}
  const commentMatch = script.match(/\/\*[*!]([\s\S]*?)\*\//)
  if (commentMatch?.[1]) {
    const comment = commentMatch[1]
    const grab = (tag: string): string | undefined => comment.match(new RegExp(`@${tag}\\s+(.+)`))?.[1]?.trim()
    const name = grab('name')
    if (name) meta.name = name
    const description = grab('description')
    if (description) meta.description = description
    const version = grab('version')
    if (version) meta.version = version
    const author = grab('author')
    if (author) meta.author = author
    const homepage = grab('repository') ?? grab('homepage')
    if (homepage) meta.homepage = homepage
  }
  return meta
}

export interface SandboxRequestLogEntry {
  ts: number
  url: string
  statusCode?: number
  error?: string
  ms: number
}

/** 音源脚本最近发起的 HTTP 请求日志（ring buffer，上限 30 条），供直链解析失败诊断。 */
const requestLog: SandboxRequestLogEntry[] = []
const REQUEST_LOG_LIMIT = 30

export function getSandboxRequestLog(): SandboxRequestLogEntry[] {
  return requestLog.slice()
}

function pushRequestLog(entry: SandboxRequestLogEntry): void {
  requestLog.push(entry)
  if (requestLog.length > REQUEST_LOG_LIMIT) requestLog.shift()
}

/** 创建 lx.request 实现（沙箱外，Node 网络能力）。
 *  回调约定与 lxserver/lx-music-desktop 一致：callback(err, response, body)，
 *  其中 response = { statusCode, statusMessage, headers, body }（body 字段内嵌，
 *  许多脚本从 response 解构 body）。 */
function createLxRequest() {
  return (url: string, options: HttpFetchOptions = {}, callback: (err: Error | null, resp?: Partial<HttpFetchResult> & { body?: unknown }, body?: unknown) => void): (() => void) => {
    const startedAt = Date.now()
    const req = httpFetch(url, {
      method: options.method,
      headers: options.headers,
      body: options.body,
      form: options.form,
      formData: options.formData,
      timeout: options.timeout,
    })
    req.promise.then(
      (resp) => {
        pushRequestLog({ ts: Date.now(), url, statusCode: resp.statusCode, ms: Date.now() - startedAt })
        if (resp.statusCode !== undefined && resp.statusCode >= 400) {
          // 非 2xx 直接告警到宿主进程 stdout（诊断「电脑解析不了、手机可以」等场景）
          console.warn(`[lx-music sandbox] 音源脚本请求 HTTP ${resp.statusCode}: ${url}`)
        }
        const safeResp = { statusCode: resp.statusCode, statusMessage: undefined as string | undefined, headers: resp.headers, body: resp.body }
        try {
          callback(null, safeResp, resp.body)
        } catch (err) {
          // 脚本回调内抛错（如访问未定义字段）不得逃逸为宿主进程的 unhandledRejection
          console.warn('[lx-music sandbox] 音源脚本 lx.request 回调抛错（已隔离）:', err)
        }
      },
      (err) => {
        pushRequestLog({ ts: Date.now(), url, error: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt })
        try {
          callback(err instanceof Error ? err : new Error(String(err)), undefined, undefined)
        } catch (err2) {
          console.warn('[lx-music sandbox] 音源脚本 lx.request 错误回调抛错（已隔离）:', err2)
        }
      },
    )
    return req.canceleFn
  }
}

/**
 * 在沙箱中加载音源脚本并等待初始化。
 * @param id 音源 id（用于错误信息）
 * @param script 脚本源码
 */
export function loadSourceScript(id: string, script: string, options: SandboxOptions = {}): Promise<LoadedSourceScript> {
  installProcessGuards()
  const initTimeoutMs = options.initTimeoutMs ?? 10_000
  const callTimeoutMs = options.callTimeoutMs ?? 20_000
  const metadata = extractScriptMetadata(script)

  return new Promise<LoadedSourceScript>((resolvePromise, rejectPromise) => {
    let settled = false
    const settle = (fn: () => void): void => {
      if (settled) return
      settled = true
      fn()
    }

    let initResolve: (() => void) | null = null
    const initPromise = new Promise<void>((resolve) => {
      initResolve = resolve
    })

    let requestHandler: ((data: { action: string; source: string; info: unknown }) => unknown) | null = null
    let registeredSources: Record<string, SourceRegistration> = {}
    let disposed = false

    const lxObject = {
      version: '2.0.0',
      env: 'desktop',
      platform: 'web',
      currentScriptInfo: {
        name: metadata.name ?? id,
        description: metadata.description ?? '',
        version: metadata.version ?? '1.0.0',
        author: metadata.author ?? '',
        homepage: metadata.homepage ?? '',
        rawScript: script,
      },
      EVENT_NAMES: {
        request: 'request',
        inited: 'inited',
        updateAlert: 'updateAlert',
      },
      utils: {
        buffer: {
          from: (d: unknown, e?: BufferEncoding) => (typeof d === 'string' ? Buffer.from(d, e) : toBuffer(d as Uint8Array)),
          bufToString: (b: unknown, f: BufferEncoding) => (typeof b === 'string' ? b : toBuffer(b as Uint8Array).toString(f)),
        },
        crypto: {
          md5: (str: string) => crypto.createHash('md5').update(str ?? '').digest('hex'),
          aesEncrypt: (buffer: Uint8Array, mode: string, key: Uint8Array, iv: Uint8Array) => {
            const cipher = crypto.createCipheriv(mode, toBuffer(key), toBuffer(iv))
            return Buffer.concat([cipher.update(toBuffer(buffer)), cipher.final()])
          },
          rsaEncrypt: (buffer: Uint8Array, key: string | crypto.KeyLike) => crypto.publicEncrypt(key, toBuffer(buffer)),
          randomBytes: (size: number) => crypto.randomBytes(size),
        },
        zlib: {
          inflate: (buffer: Uint8Array) => new Promise<Buffer>((resolve, reject) => zlib.inflate(toBuffer(buffer), (err, out) => (err ? reject(err) : resolve(out)))),
          deflate: (buffer: Uint8Array) => new Promise<Buffer>((resolve, reject) => zlib.deflate(toBuffer(buffer), (err, out) => (err ? reject(err) : resolve(out)))),
        },
      },
      request: createLxRequest(),
      send: (eventName: string, data: unknown): void => {
        const dData = decontextify(data) as { sources?: Record<string, SourceRegistration> }
        if (eventName === 'inited') {
          if (dData && dData.sources) registeredSources = dData.sources
          initResolve?.()
        } else if (eventName === 'updateAlert') {
          // 更新告警：记录但不阻断
        }
      },
      on: (eventName: string, handler: (data: { action: string; source: string; info: unknown }) => unknown): void => {
        if (eventName === 'request') requestHandler = handler
      },
    }

    const sandbox: Record<string, unknown> = {
      console,
      setTimeout: (fn: () => void, ms?: number, ...args: unknown[]) => setTimeout(safeTimer(fn), ms, ...args),
      clearTimeout,
      setInterval: (fn: () => void, ms?: number, ...args: unknown[]) => setInterval(safeTimer(fn), ms, ...args),
      clearInterval,
      Buffer,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      atob: (s: string) => Buffer.from(s, 'base64').toString('binary'),
      btoa: (s: string) => Buffer.from(s, 'binary').toString('base64'),
      crypto: {
        getRandomValues: (arr: Uint8Array) => crypto.randomFillSync(arr),
      },
      process: {
        nextTick: (fn: () => void) => setTimeout(safeTimer(fn), 0),
        env: { NODE_ENV: process.env.NODE_ENV ?? 'production' },
      },
      lx: lxObject,
    }
    sandbox.global = sandbox
    sandbox.window = sandbox
    sandbox.globalThis = sandbox

    let context: vm.Context
    try {
      context = vm.createContext(sandbox)
    } catch (err) {
      settle(() => rejectPromise(new SourceScriptError('init', `沙箱创建失败: ${err instanceof Error ? err.message : String(err)}`)))
      return
    }

    const call = async (action: string, source: string, info: unknown): Promise<unknown> => {
      if (disposed) throw new SourceScriptError('call', `音源 ${id} 已卸载`)
      if (!requestHandler) throw new SourceScriptError('call', `音源 ${id} 未注册 request 处理器`)
      const input = { action, source, info }
      const result = await Promise.race([
        Promise.resolve(requestHandler(input)),
        new Promise<never>((_, reject) => setTimeout(() => reject(new SourceScriptError('call', `音源 ${id} 请求超时（>${callTimeoutMs}ms）`)), callTimeoutMs)),
      ])
      return decontextify(result)
    }

    // 初始化超时
    const initTimer = setTimeout(() => {
      if (!settled) {
        dispose()
        settle(() => rejectPromise(new SourceScriptError('init', `音源 ${id} 初始化超时（未调用 lx.send("inited")）`)))
      }
    }, initTimeoutMs)

    const dispose = (): void => {
      disposed = true
      clearTimeout(initTimer)
      if (context) {
        try {
          vm.runInContext('', context)
        } catch {
          // 忽略清理错误
        }
      }
    }

    try {
      vm.runInContext(script, context, { filename: `source_${id}.js`, timeout: initTimeoutMs })
    } catch (err) {
      clearTimeout(initTimer)
      settle(() => rejectPromise(new SourceScriptError('init', `音源 ${id} 执行失败: ${err instanceof Error ? err.message : String(err)}`)))
      return
    }

    void initPromise.then(() => {
      clearTimeout(initTimer)
      settle(() =>
        resolvePromise({
          id,
          name: metadata.name ?? id,
          version: metadata.version,
          author: metadata.author,
          description: metadata.description,
          homepage: metadata.homepage,
          sources: registeredSources,
          call,
          dispose,
        }),
      )
    })
  })
}
