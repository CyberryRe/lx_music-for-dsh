// 滑动窗口限流器：用于 LLM 点歌工具的防刷。

export interface RateLimitOptions {
  /** 窗口长度（毫秒）。 */
  windowMs?: number
  /** 每个窗口内允许的最大调用次数。 */
  maxCalls: number
}

export interface RateLimitStatus {
  allowed: boolean
  remaining: number
  resetAt: number // 下次可用时间戳（ms）
  retryAfterMs: number
}

/** 滑动窗口限流器（进程内，单实例语义）。 */
export class SlidingWindowRateLimiter {
  private readonly windowMs: number
  private maxCalls: number
  private timestamps: number[] = []

  constructor(options: RateLimitOptions) {
    if (options.maxCalls <= 0) throw new Error('maxCalls must be positive')
    this.windowMs = options.windowMs ?? 60_000
    this.maxCalls = options.maxCalls
  }

  /** 更新窗口上限（重置计数）。 */
  setMaxCalls(maxCalls: number): void {
    if (maxCalls <= 0) throw new Error('maxCalls must be positive')
    this.maxCalls = maxCalls
    this.reset()
  }

  /** 尝试消耗一次配额。 */
  tryConsume(now: number = Date.now()): RateLimitStatus {
    this.prune(now)
    if (this.timestamps.length >= this.maxCalls) {
      const oldest = this.timestamps[0] ?? now
      const resetAt = oldest + this.windowMs
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterMs: Math.max(0, resetAt - now),
      }
    }
    this.timestamps.push(now)
    return {
      allowed: true,
      remaining: this.maxCalls - this.timestamps.length,
      resetAt: now + this.windowMs,
      retryAfterMs: 0,
    }
  }

  /** 当前窗口内已消耗次数。 */
  count(now: number = Date.now()): number {
    this.prune(now)
    return this.timestamps.length
  }

  /** 重置（测试与设置变更用）。 */
  reset(): void {
    this.timestamps = []
  }

  private prune(now: number): void {
    const cutoff = now - this.windowMs
    while (this.timestamps.length > 0 && (this.timestamps[0] ?? 0) <= cutoff) {
      this.timestamps.shift()
    }
  }
}
