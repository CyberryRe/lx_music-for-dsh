// SDK 统一请求层（node:http/https 实现，兼容 lx-music-desktop musicSdk 的 httpFetch 接口）。
// 移植自 lx-music-desktop（Apache-2.0），原实现基于 needle；此处用 Node 内置模块实现，
// 避免外部依赖。接口契约：httpFetch(url, options) → { promise, canceleFn }，
// promise resolve { statusCode, headers, body }（body 自动 JSON.parse）。

import * as http from 'node:http'
import * as https from 'node:https'
import * as zlib from 'node:zlib'

export interface HttpFetchOptions {
  method?: string
  headers?: Record<string, string>
  /** 原始字符串 body。 */
  body?: unknown
  /** 表单对象（URL-encoded）。 */
  form?: Record<string, unknown>
  /** 表单对象（URL-encoded，与 form 同义，兼容原 SDK 用法）。 */
  formData?: Record<string, unknown>
  timeout?: number
  /** 不自动 JSON.parse（返回原始字符串）。 */
  responseType?: 'text' | 'json'
}

export interface HttpFetchResult {
  statusCode?: number
  headers: Record<string, string | string[] | undefined>
  body: unknown
  raw: Buffer
}

const DEFAULT_TIMEOUT = 15_000

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function urlencodeForm(data: Record<string, unknown>): string {
  return Object.entries(data)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(typeof v === 'string' ? v : JSON.stringify(v))}`)
    .join('&')
}

export function httpFetch(url: string, options: HttpFetchOptions = {}): { promise: Promise<HttpFetchResult>; canceleFn: () => void } {
  const method = (options.method ?? 'get').toLowerCase()
  const timeout = options.timeout ?? DEFAULT_TIMEOUT

  const controller = new AbortController()
  let cancelled = false

  const promise = (async () => {
    let body: string | undefined
    const headers: Record<string, string> = { ...(options.headers ?? {}) }
    if (options.form || options.formData) {
      body = urlencodeForm((options.form ?? options.formData)!)
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/x-www-form-urlencoded'
    } else if (typeof options.body === 'string') {
      body = options.body
    } else if (options.body !== undefined) {
      body = JSON.stringify(options.body)
      if (!headers['Content-Type']) headers['Content-Type'] = 'application/json'
    }

    return new Promise<HttpFetchResult>((resolve, reject) => {
      const transport = url.startsWith('https:') ? https : http
      const req = transport.request(url, {
        method,
        headers,
        signal: controller.signal,
      }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => {
          let raw = Buffer.concat(chunks)
          const encoding = String(res.headers['content-encoding'] ?? '').toLowerCase()
          try {
            if (encoding === 'gzip') raw = zlib.gunzipSync(raw)
            else if (encoding === 'deflate') raw = zlib.inflateSync(raw)
          } catch {
            // 解压失败时保留原始内容
          }
          let parsed: unknown = raw.toString('utf8')
          if ((options.responseType ?? 'json') === 'json') {
            try {
              parsed = JSON.parse(raw.toString('utf8'))
            } catch {
              parsed = raw.toString('utf8')
            }
          }
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: parsed,
            raw,
          })
        })
        res.on('error', reject)
      })
      req.on('error', (err) => {
        if (cancelled) reject(new Error('cancelled'))
        else reject(err)
      })
      req.setTimeout(timeout, () => {
        controller.abort()
        reject(new Error(`timeout (${timeout}ms)`))
      })
      if (body !== undefined) req.write(body)
      req.end()
    })
  })()

  return {
    promise,
    canceleFn: () => {
      cancelled = true
      controller.abort()
    },
  }
}

/** 兼容原 SDK 的简单对象判断导出。 */
export { isObject }
