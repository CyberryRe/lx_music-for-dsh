// 迷你测试运行器兼容层：在 node:test 之上提供 vitest 风格的 describe/it/expect/vi。
// 用途：受限沙箱（禁止子进程 spawn）下单进程运行测试（node --test）。

import { describe, it, mock, afterEach } from 'node:test'
import assert from 'node:assert/strict'

export { describe, it, afterEach }

/** vi 兼容 shim（仅测试用到的子集）。 */
export const vi = {
  stubs: new Map<string, unknown>(),
  stubGlobal(name: string, value: unknown): void {
    if (!this.stubs.has(name)) {
      this.stubs.set(name, (globalThis as Record<string, unknown>)[name])
    }
    ;(globalThis as Record<string, unknown>)[name] = value
  },
  unstubAllGlobals(): void {
    for (const [name, value] of this.stubs) {
      if (value === undefined) delete (globalThis as Record<string, unknown>)[name]
      else (globalThis as Record<string, unknown>)[name] = value
    }
    this.stubs.clear()
  },
  useFakeTimers(): void {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  },
  useRealTimers(): void {
    mock.timers.reset()
  },
  async advanceTimersByTimeAsync(ms: number): Promise<void> {
    mock.timers.tick(ms)
    // flush 微任务/宏任务
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))
  },
  /** vi.fn 兼容：原样返回实现函数（单进程 runner 无需 mock 追踪）。 */
  fn<T>(impl: T): T {
    return impl
  },
}

function fail(message: string): never {
  throw new Error(message)
}

function deepMatchObject(actual: unknown, expected: Record<string, unknown>, path: string): void {
  if (typeof actual !== 'object' || actual === null) fail(`${path}: 期望对象，实际 ${String(actual)}`)
  for (const [key, exp] of Object.entries(expected)) {
    const act = (actual as Record<string, unknown>)[key]
    if (exp && typeof exp === 'object' && !Array.isArray(exp)) {
      deepMatchObject(act, exp as Record<string, unknown>, `${path}.${key}`)
    } else if (Array.isArray(exp)) {
      if (!Array.isArray(act)) fail(`${path}.${key}: 期望数组`)
      if (exp.length !== act.length) fail(`${path}.${key}: 长度不一致 (期望 ${exp.length}, 实际 ${act.length})`)
      for (let i = 0; i < exp.length; i++) {
        const e = exp[i]
        if (e && typeof e === 'object') deepMatchObject(act[i], e as Record<string, unknown>, `${path}.${key}[${i}]`)
        else if (!Object.is(act[i], e)) fail(`${path}.${key}[${i}]: ${String(act[i])} !== ${String(e)}`)
      }
    } else if (!Object.is(act, exp)) {
      fail(`${path}.${key}: 期望 ${JSON.stringify(exp)}, 实际 ${JSON.stringify(act)}`)
    }
  }
}

/** promise 断言接口（避免 index signature 受 noUncheckedIndexedAccess 影响）。 */
export interface PromiseAssertions {
  toMatchObject(expected: Record<string, unknown>): Promise<void>
  toThrow(matcher?: string | RegExp): Promise<void>
  toContain(expected: unknown): Promise<void>
  toHaveLength(n: number): Promise<void>
  toBe(expected: unknown): Promise<void>
  toMatch(pattern: string | RegExp): Promise<void>
  toBeGreaterThan(n: number): Promise<void>
  toBeGreaterThanOrEqual(n: number): Promise<void>
  toBeLessThanOrEqual(n: number): Promise<void>
  toBeNull(): Promise<void>
  toBeTruthy(): Promise<void>
  toBeInstanceOf(cls: unknown): Promise<void>
}

class MiniExpect {
  constructor(protected readonly actual: unknown) {}

  get not(): MiniExpect {
    return new NegatedExpect(this.actual)
  }

  toBe(expected: unknown): void {
    if (!Object.is(this.actual, expected)) fail(`期望 ${String(expected)}, 实际 ${String(this.actual)}`)
  }
  toEqual(expected: unknown): void {
    try {
      assert.deepEqual(this.actual, expected)
    } catch (err) {
      fail(`不相等: ${String(err)}`)
    }
  }
  toMatchObject(expected: Record<string, unknown>): void {
    deepMatchObject(this.actual, expected, '$')
  }
  toContain(expected: unknown): void {
    if (typeof this.actual === 'string') {
      if (!(this.actual as string).includes(String(expected))) fail(`"${this.actual}" 不包含 "${String(expected)}"`)
    } else if (Array.isArray(this.actual)) {
      if (!this.actual.includes(expected)) fail(`数组不包含 ${String(expected)}`)
    } else {
      fail('toContain 仅支持 string/array')
    }
  }
  toHaveLength(n: number): void {
    const len = (this.actual as { length?: unknown }).length
    if (len !== n) fail(`期望长度 ${n}, 实际 ${String(len)}`)
  }
  toMatch(pattern: string | RegExp): void {
    const str = String(this.actual)
    if (pattern instanceof RegExp) {
      if (!pattern.test(str)) fail(`"${str}" 不匹配 ${pattern}`)
    } else if (!str.includes(pattern)) {
      fail(`"${str}" 不包含 "${pattern}"`)
    }
  }
  toThrow(matcher?: string | RegExp | Error): void {
    // rejects 场景：actual 是拒绝原因（Error 等），直接匹配其消息
    if (typeof this.actual !== 'function') {
      const message = this.actual instanceof Error ? this.actual.message : String(this.actual)
      if (matcher instanceof RegExp) {
        if (!matcher.test(message)) fail(`错误消息不匹配 ${matcher}: ${message}`)
      } else if (typeof matcher === 'string') {
        if (!message.includes(matcher)) fail(`错误消息不包含 "${matcher}": ${message}`)
      } else if (matcher instanceof Error) {
        if (message !== matcher.message) fail(`错误不匹配: ${message}`)
      }
      return
    }
    try {
      ;(this.actual as () => void)()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      if (matcher instanceof RegExp) {
        if (!matcher.test(message)) fail(`错误消息不匹配 ${matcher}: ${message}`)
      } else if (typeof matcher === 'string') {
        if (!message.includes(matcher)) fail(`错误消息不包含 "${matcher}": ${message}`)
      } else if (matcher instanceof Error) {
        if (message !== matcher.message) fail(`错误不匹配: ${message}`)
      }
      return
    }
    fail('函数未抛出异常')
  }
  /** 断言 promise 被拒绝：expect(p).rejects.toMatchObject(...) / .toThrow(...)。 */
  get rejects(): PromiseAssertions {
    const self = this
    const make = (method: string) => async (...args: unknown[]) => {
      let reason: unknown
      try {
        await (self.actual as Promise<unknown>)
      } catch (err) {
        reason = err
      }
      if (reason === undefined) fail(`期望 promise 被拒绝，实际成功 resolve`)
      const inner = new MiniExpect(reason) as unknown as Record<string, (a: unknown) => void>
      const fn = inner[method]
      if (!fn) fail(`不支持的断言: ${method}`)
      fn.call(inner, args[0])
    }
    return new Proxy({} as never, {
      get: (_t, prop: string) => make(prop),
    }) as PromiseAssertions
  }

  /** 断言 promise 成功：expect(p).resolves.toBe(...)。 */
  get resolves(): PromiseAssertions {
    const self = this
    const make = (method: string) => async (...args: unknown[]) => {
      let value: unknown
      try {
        value = await (self.actual as Promise<unknown>)
      } catch (err) {
        fail(`期望 promise 成功，实际被拒绝: ${String(err)}`)
      }
      const inner = new MiniExpect(value) as unknown as Record<string, (a: unknown) => void>
      const fn = inner[method]
      if (!fn) fail(`不支持的断言: ${method}`)
      fn.call(inner, args[0])
    }
    return new Proxy({} as never, {
      get: (_t, prop: string) => make(prop),
    }) as PromiseAssertions
  }
  toBeGreaterThan(n: number): void {
    if (!(Number(this.actual) > n)) fail(`${String(this.actual)} 不大于 ${n}`)
  }
  toBeGreaterThanOrEqual(n: number): void {
    if (!(Number(this.actual) >= n)) fail(`${String(this.actual)} 小于 ${n}`)
  }
  toBeLessThanOrEqual(n: number): void {
    if (!(Number(this.actual) <= n)) fail(`${String(this.actual)} 大于 ${n}`)
  }
  toBeNull(): void {
    if (this.actual !== null) fail(`期望 null, 实际 ${String(this.actual)}`)
  }
  toBeTruthy(): void {
    if (!this.actual) fail(`期望 truthy, 实际 ${String(this.actual)}`)
  }
  toBeInstanceOf(cls: unknown): void {
    if (!(this.actual instanceof (cls as new () => unknown))) fail(`不是 ${String(cls)} 的实例`)
  }
}

class NegatedExpect extends MiniExpect {
  override toBe(expected: unknown): void {
    if (Object.is(this.actual, expected)) fail(`期望不等于 ${String(expected)}`)
  }
  override toContain(expected: unknown): void {
    if (typeof this.actual === 'string' && (this.actual as string).includes(String(expected))) fail(`不应包含 "${String(expected)}"`)
  }
}

/** 解析 Promise 的断言包装：expect(p).rejects.toMatchObject(...) / await expect(p).rejects... */
export function expect(actual: unknown): MiniExpect {
  return new MiniExpect(actual)
}
