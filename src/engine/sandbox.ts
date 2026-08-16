// 音源脚本沙箱（子进程隔离重构，安全复核修复）：
// 第三方音源脚本（不可信 JS）在**独立子进程**（lib/runner.cjs；测试编译产物 runner.js）中执行，
// 宿主进程只通过 IPC 与其交换 JSON 消息。子进程携带：
//   - SSRF 网络策略（lx.request 默认拦截私网/回环/链路本地地址）
//   - 白名单环境变量（不含 DSH 机密）
//   - 初始化/调用超时杀进程兜底（同步死循环只能卡死子进程，宿主不受影响）
// 脚本的任何故障（异常、逃逸尝试、死循环、定时器泄漏）都被限制在子进程内：
// 退出即回收全部句柄与定时器；下一次 `call` 惰性重启子进程（重新执行 init）。
//
// 协议（与 src/engine/runner.js 对应）：
//   宿主 → 子进程：init { id, script, initTimeoutMs, allowPrivate, metadata }
//                 call { callId, action, source, info }
//                 shutdown
//   子进程 → 宿主：init-result { ok, sources?, error? }
//                 call-result { callId, ok, value?, error? }
//                 httplog { url, statusCode?, error?, ms }
//                 console { level, text }

import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  /** 调用脚本请求处理器（在子进程中执行）。 */
  call(action: string, source: string, info: unknown): Promise<unknown>
  /** 终止子进程并回收资源。 */
  dispose(): void
}

export interface SandboxOptions {
  /** 脚本初始化超时（等待 lx.send('inited')）。 */
  initTimeoutMs?: number
  /** 单次请求调用超时（超时则终止子进程，下次调用自动重启）。 */
  callTimeoutMs?: number
  /** 覆盖 runner 可执行文件路径（默认与当前模块同目录的 runner.cjs / runner.js）。 */
  runnerPath?: string
  /** 允许音源脚本访问内网/回环地址（默认 false；仅测试/调试场景开启）。 */
  allowPrivateNetwork?: boolean
  /** 子进程 console 转发条数上限（默认 200，防日志刷屏）。 */
  consoleLimit?: number
}

export class SourceScriptError extends Error {
  readonly stage: 'init' | 'call' | 'validate'
  constructor(stage: SourceScriptError['stage'], message: string) {
    super(message)
    this.name = 'SourceScriptError'
    this.stage = stage
  }
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

// ── runner 定位与子进程环境 ─────────────────────────────────────────────────

/**
 * 定位音源脚本 runner 可执行文件。
 * - rollup 产物（lib/index.js）：`__dirname` 由 build.mjs banner 注入，取 lib/runner.cjs；
 * - tsc 测试编译（.test-dist/src/engine/sandbox.js）：`__dirname` 为本机产物目录，取 runner.js。
 */
function resolveRunnerPath(): string {
  const explicit = process.env.LX_MUSIC_RUNNER_PATH
  if (explicit) return explicit
  if (typeof __dirname !== 'string') {
    throw new SourceScriptError('init', '无法解析音源脚本 runner 路径（当前环境无 __dirname，请显式传入 runnerPath）')
  }
  const candidates = [join(__dirname, 'runner.cjs'), join(__dirname, 'runner.js')]
  for (const p of candidates) {
    if (existsSync(p)) return p
  }
  return candidates[0]!
}

/** 子进程环境白名单：只透传系统路径与代理变量，不泄漏任何 DSH 机密。 */
function buildChildEnv(): Record<string, string> {
  const env: Record<string, string> = { NODE_ENV: process.env.NODE_ENV ?? 'production' }
  const allowlist = [
    'SystemRoot', 'TEMP', 'TMP', 'TMPDIR', 'ComSpec', 'PATHEXT',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy',
  ]
  for (const key of allowlist) {
    const value = process.env[key]
    if (value) env[key] = value
  }
  return env
}

// ── 子进程消息（与 runner.js 对应）──────────────────────────────────────────

interface WireCallResult {
  type: 'call-result'
  callId: number
  ok: boolean
  value?: unknown
  error?: { message: string }
}
interface WireInitResult {
  type: 'init-result'
  ok: boolean
  sources?: Record<string, SourceRegistration>
  error?: string
}
interface WireConsole {
  type: 'console'
  level: string
  text: string
}
interface WireHttpLog {
  type: 'httplog'
  url: string
  statusCode?: number
  error?: string
  ms: number
}
type WireMessage = WireInitResult | WireCallResult | WireConsole | WireHttpLog

interface PendingCall {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * 在子进程中加载音源脚本并等待初始化完成。
 * @param id 音源 id（用于错误信息与子进程 filename 标记）
 * @param script 脚本源码
 */
export function loadSourceScript(id: string, script: string, options: SandboxOptions = {}): Promise<LoadedSourceScript> {
  const initTimeoutMs = options.initTimeoutMs ?? 10_000
  const callTimeoutMs = options.callTimeoutMs ?? 20_000
  const consoleLimit = options.consoleLimit ?? 200
  const runnerPath = resolveRunnerPath()
  const metadata = extractScriptMetadata(script)

  let child: ChildProcess | null = null
  let spawning: Promise<void> | null = null
  let pending = new Map<number, PendingCall>()
  let seq = 0
  let sources: Record<string, SourceRegistration> = {}
  let disposed = false
  let consoleCount = 0

  const handle: LoadedSourceScript = {
    id,
    name: metadata.name ?? id,
    version: metadata.version,
    author: metadata.author,
    description: metadata.description,
    homepage: metadata.homepage,
    sources,
    call,
    dispose,
  }

  function failPending(err: Error): void {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  function killChild(): void {
    if (!child) return
    try {
      child.kill()
    } catch {
      // 已退出
    }
    child = null
  }

  /** 启动子进程并完成 init（幂等：已有存活子进程时直接返回）。 */
  function startChild(): Promise<void> {
    if (child) return Promise.resolve()
    if (!existsSync(runnerPath)) {
      return Promise.reject(new SourceScriptError('init', `音源脚本 runner 不存在: ${runnerPath}（请确认构建产物包含 lib/runner.cjs）`))
    }
    return new Promise<void>((resolveStart, rejectStart) => {
      let initResolved = false
      let initFailed = false

      const failInit = (err: SourceScriptError): void => {
        if (initResolved || initFailed) return
        initFailed = true
        clearTimeout(initTimer)
        failPending(err)
        killChild()
        rejectStart(err)
      }

      const proc = spawn(process.execPath, [runnerPath], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        env: buildChildEnv(),
        cwd: tmpdir(),
        windowsHide: true,
      })
      child = proc
      // 不因子进程句柄拖住宿主事件循环（测试进程/宿主退出时，子进程经 IPC disconnect 自清理）
      proc.unref()

      const initTimer = setTimeout(() => {
        failInit(new SourceScriptError('init', `音源 ${id} 初始化超时（>${initTimeoutMs}ms，未调用 lx.send("inited")）`))
      }, initTimeoutMs)

      proc.on('spawn', () => {
        try {
          proc.send({
            type: 'init',
            id,
            script,
            initTimeoutMs,
            allowPrivate: options.allowPrivateNetwork === true,
            metadata,
          })
        } catch (err) {
          failInit(new SourceScriptError('init', `音源 ${id} 无法向子进程发送初始化消息: ${err instanceof Error ? err.message : String(err)}`))
        }
      })

      proc.on('message', (msg: WireMessage) => {
        try {
          switch (msg.type) {
            case 'console': {
              if (consoleCount++ < consoleLimit) {
                const level = msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : msg.level === 'debug' ? 'debug' : 'log'
                console[level](`[lx-music sandbox:${id}] ${msg.text}`)
              }
              break
            }
            case 'httplog': {
              pushRequestLog({ ts: Date.now(), url: msg.url, statusCode: msg.statusCode, error: msg.error, ms: msg.ms })
              break
            }
            case 'init-result': {
              clearTimeout(initTimer)
              if (msg.ok) {
                initResolved = true
                // 原地更新（handle.sources 引用同一对象，重载后再赋值不会生效）
                for (const key of Object.keys(sources)) delete sources[key]
                Object.assign(sources, msg.sources ?? {})
                resolveStart()
              } else {
                failInit(new SourceScriptError('init', `音源 ${id} 初始化失败: ${msg.error ?? '未知错误'}`))
              }
              break
            }
            case 'call-result': {
              const p = pending.get(msg.callId)
              if (!p) break
              pending.delete(msg.callId)
              clearTimeout(p.timer)
              if (msg.ok) {
                p.resolve(msg.value)
              } else {
                p.reject(new SourceScriptError('call', `音源 ${id} 调用失败: ${msg.error?.message ?? '未知错误'}`))
              }
              break
            }
          }
        } catch (err) {
          console.warn('[lx-music sandbox] 处理子进程消息失败:', err)
        }
      })

      proc.on('error', (err) => {
        failInit(new SourceScriptError('init', `音源 ${id} 子进程启动失败: ${err.message}`))
      })

      proc.on('exit', (code, signal) => {
        clearTimeout(initTimer)
        const exitDesc = `code=${code ?? 'null'}${signal ? ` signal=${signal}` : ''}`
        if (!initResolved && !initFailed) {
          // 初始化期间退出 → 本次加载失败，下次 call 会重新启动
          failInit(new SourceScriptError('init', `音源 ${id} 子进程在初始化期间退出（${exitDesc}）`))
        } else if (initResolved) {
          // init 完成后的异常退出：挂起中的调用失败；下一次 call 自动重启
          child = null
          failPending(new SourceScriptError('call', `音源 ${id} 子进程异常退出（${exitDesc}），将在下次调用时重启`))
        }
      })
    })
  }

  function ensureStarted(): Promise<void> {
    if (child) return Promise.resolve()
    if (!spawning) {
      const start = startChild().finally(() => {
        spawning = null
      })
      spawning = start
    }
    return spawning
  }

  async function call(action: string, source: string, info: unknown): Promise<unknown> {
    if (disposed) throw new SourceScriptError('call', `音源 ${id} 已卸载`)
    await ensureStarted()
    if (disposed) throw new SourceScriptError('call', `音源 ${id} 已卸载`)
    if (!child) throw new SourceScriptError('call', `音源 ${id} 子进程不可用`)
    const callId = ++seq
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId)
        const err = new SourceScriptError('call', `音源 ${id} 请求超时（>${callTimeoutMs}ms），已终止该音源子进程，下次调用将自动重启`)
        // 一个调用卡死（如同步死循环）说明进程整体不可用：终止全部挂起调用与子进程
        failPending(err)
        killChild()
        reject(err)
      }, callTimeoutMs)
      pending.set(callId, { resolve, reject, timer })
      try {
        child!.send({ type: 'call', callId, action, source, info })
      } catch (err) {
        clearTimeout(timer)
        pending.delete(callId)
        reject(new SourceScriptError('call', `音源 ${id} 消息发送失败: ${err instanceof Error ? err.message : String(err)}`))
      }
    })
  }

  function dispose(): void {
    if (disposed) return
    disposed = true
    failPending(new SourceScriptError('call', `音源 ${id} 已卸载`))
    if (child) {
      try {
        child.send({ type: 'shutdown' })
      } catch {
        // 通道已关闭
      }
      killChild()
    }
  }

  return startChild().then(() => handle)
}