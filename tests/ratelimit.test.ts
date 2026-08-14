// 限流器测试：滑动窗口允许/拒绝、窗口滑动、重置。

import { describe, expect, it } from './mini'
import { SlidingWindowRateLimiter } from '../src/ratelimit'

describe('SlidingWindowRateLimiter', () => {
  it('窗口内允许 maxCalls 次调用', () => {
    const rl = new SlidingWindowRateLimiter({ maxCalls: 3, windowMs: 60_000 })
    expect(rl.tryConsume(1000).allowed).toBe(true)
    expect(rl.tryConsume(2000).allowed).toBe(true)
    expect(rl.tryConsume(3000).allowed).toBe(true)
    expect(rl.count(4000)).toBe(3)
    const denied = rl.tryConsume(4000)
    expect(denied.allowed).toBe(false)
    expect(denied.remaining).toBe(0)
    expect(denied.resetAt).toBe(61_000)
  })

  it('窗口滑动后配额恢复', () => {
    const rl = new SlidingWindowRateLimiter({ maxCalls: 2, windowMs: 10_000 })
    rl.tryConsume(0)
    rl.tryConsume(1000)
    expect(rl.tryConsume(2000).allowed).toBe(false)
    // 第一次调用（0）在 10s 后过期，第二次（1000）仍在窗口内
    expect(rl.tryConsume(10_000).allowed).toBe(true)
    expect(rl.tryConsume(10_001).allowed).toBe(false) // 1000 与 10000 仍占满 2 次
    expect(rl.tryConsume(11_000).allowed).toBe(true) // 1000 恰好过期（边界 >= windowMs）
  })

  it('retryAfterMs 给出正确的等待时间', () => {
    const rl = new SlidingWindowRateLimiter({ maxCalls: 1, windowMs: 5000 })
    rl.tryConsume(1000)
    const denied = rl.tryConsume(3000)
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterMs).toBe(3000)
  })

  it('reset 与 setMaxCalls 重置计数', () => {
    const rl = new SlidingWindowRateLimiter({ maxCalls: 1, windowMs: 60_000 })
    rl.tryConsume(0)
    expect(rl.count(0)).toBe(1)
    rl.reset()
    expect(rl.count(0)).toBe(0)
    rl.tryConsume(0)
    rl.setMaxCalls(5)
    expect(rl.count(0)).toBe(0)
    expect(rl.tryConsume(0).allowed).toBe(true)
  })

  it('非法参数抛出错误', () => {
    expect(() => new SlidingWindowRateLimiter({ maxCalls: 0 })).toThrow()
  })
})

