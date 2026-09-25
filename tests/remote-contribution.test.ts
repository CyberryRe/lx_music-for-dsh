// TYPERT client 面（remoteContribution）的契约测试。
//
// 这个文件锁定两类**在浏览器里才会炸**的问题 —— 它们都不会被普通单元测试覆盖，
// 因为 client bundle 的激活失败只表现为 DSH shell 的
// `web boot: N entries did not activate`，且本仓库没有常驻浏览器：
//
// 1) strict codec 的 wire 形状（0.1.5 与 0.1.7 的契约正好相反）：
//    0.1.5 是 `{ mode, typeSymbol, schema }`，校验 `typeof codec.schema.parse === 'function'`、
//    解码 `codec.schema.parse(v)`；0.1.7 移除了 `schema`，要求 `create(): TypertSchema`，
//    校验 `typeof codec.create === 'function'`、解码 `codec.create().parse(v)`。
//    只满足一边会让 `ctx.remote.$mount()` 抛 "strict codec has no … factory/parse() method"，
//    整个 client 插件无法激活（GUI 报 "web boot: N entries did not activate"）。
//    本仓库的方案是两个字段**同时**提供，因此这里逐字复刻**两个版本**的校验+解码路径。
// 2) client 面与 host `@Remote` 方法的**双向一致**：漏一个方法 / 参数个数对不上，
//    调用会在 wire 层被拒（"rejected <param>"）或直接找不到端点。

import { describe, expect, it } from './mini'
import { Context } from '@deepseek-ai/cordis'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import type { InvocationDescriptor, TypertCodec } from '@deepseek-ai/dsh-typert-protocol'
import { LXP_REMOTE_CONTRIBUTION } from '../src/ui/remoteContribution'
import { PlaybackService } from '../src/playback'
import { DEFAULT_SETTINGS } from '../src/shared/types'

/** wire 段字符集（与 dsh-typert-registry 的 validateWireName 一致）。 */
const WIRE_NAME = /^[A-Za-z0-9_$.-]+$/

/** 取出 strict codec 分支，非 strict 直接失败。 */
function strictCodec(codec: TypertCodec, subject: string): Extract<TypertCodec, { mode: 'strict' }> {
  if (codec.mode !== 'strict') throw new Error(`${subject}: 期望 strict codec，实际 ${codec.mode}`)
  return codec
}

/** 一个 descriptor 上的所有 codec（结果 + 每个参数）。 */
function codecsOf(descriptor: InvocationDescriptor): Array<[string, TypertCodec]> {
  return [
    [`${descriptor.method}:result`, descriptor.result],
    ...descriptor.parameters.map((p) => [`${descriptor.method}:${p.name}`, p.codec] as [string, TypertCodec]),
  ]
}

describe('TYPERT client 面契约（remoteContribution）', () => {
  it('每个 strict codec 同时携带 0.1.7 的 create() 与 0.1.5 的 schema', () => {
    for (const descriptor of LXP_REMOTE_CONTRIBUTION.descriptors) {
      for (const [subject, raw] of codecsOf(descriptor)) {
        const codec = strictCodec(raw, subject)
        expect(typeof codec.typeSymbol).toBe('string')
        expect(codec.typeSymbol.length).toBeGreaterThan(0)
        // 0.1.7：dsh-typert-registry 的 validateCodec 要求 create() 是函数。
        expect(typeof codec.create).toBe('function')
        const schema = codec.create()
        expect(typeof schema.parse).toBe('function')
        // 记忆化：同一次边界使用不应反复重建 schema。
        expect(codec.create()).toBe(schema)
        // 0.1.5：validateCodec 要求 codec.schema.parse 是函数（0.1.7 已移除该字段，
        // 但保留它才能让同一份 bundle 在两个运行时上都激活）。
        const legacy = (codec as { schema?: { parse?: unknown } }).schema
        if (legacy === undefined) throw new Error(`${subject}: 缺少 0.1.5 兼容所需的 schema 字段`)
        expect(typeof legacy.parse).toBe('function')
      }
    }
  })

  it('两套 DSH 版本的校验 + 解码路径都能走通（逐字复刻两个版本的实现）', () => {
    const byMethod = new Map(LXP_REMOTE_CONTRIBUTION.descriptors.map((d) => [d.method, d]))
    const paramCodec = (method: string, param: string): TypertCodec => {
      const p = byMethod.get(method)!.parameters.find((x) => x.name === param)
      if (p === undefined) throw new Error(`缺少参数 ${method}/${param}`)
      return p.codec
    }

    // ── 0.1.5：dsh-typert-registry/lib/client.js
    //    if (typeof codec.schema.parse !== 'function') throw new Error('strict codec has no parse() method')
    //    dsh-api-gateway decode: value = codec.schema.parse(value)
    const validate015 = (codec: TypertCodec, subject: string): { parse(v: unknown): unknown } => {
      const strict = codec as { schema?: { parse?: unknown } }
      if (strict.schema === undefined || typeof strict.schema.parse !== 'function') {
        throw new Error(`typert(0.1.5): ${subject} strict codec has no parse() method`)
      }
      return strict.schema as { parse(v: unknown): unknown }
    }
    expect(validate015(paramCodec('seek', 'seconds'), 'seek:seconds').parse(12.5)).toBe(12.5)
    expect(validate015(paramCodec('setMute', 'mute'), 'setMute:mute').parse(true)).toBe(true)
    expect(validate015(paramCodec('addMusic', 'position'), 'addMusic:position').parse('next')).toBe('next')

    // ── 0.1.7：dsh-typert-registry/lib/client.js
    //    if (typeof codec.create !== 'function') throw new Error('strict codec has no create() factory')
    //    dsh-api-gateway decode: value = codec.create().parse(value)
    const validate017 = (codec: TypertCodec, subject: string): { parse(v: unknown): unknown } => {
      if (codec.mode !== 'strict' || typeof codec.create !== 'function') {
        throw new Error(`typert(0.1.7): ${subject} strict codec has no create() factory`)
      }
      return codec.create() as unknown as { parse(v: unknown): unknown }
    }
    expect(validate017(paramCodec('seek', 'seconds'), 'seek:seconds').parse(12.5)).toBe(12.5)
    expect(validate017(paramCodec('setMute', 'mute'), 'setMute:mute').parse(true)).toBe(true)
    expect(validate017(paramCodec('addMusic', 'position'), 'addMusic:position').parse('next')).toBe('next')

    // 结果 codec 同样要过两套校验（两个版本都会 decode 返回值）。
    const result = byMethod.get('getState')!.result
    expect(typeof validate015(result, 'getState:result').parse).toBe('function')
    expect(typeof validate017(result, 'getState:result').parse).toBe('function')
  })

  it('create() 产出的 schema 真的能解析（不是空壳）', () => {
    const byMethod = new Map(LXP_REMOTE_CONTRIBUTION.descriptors.map((d) => [d.method, d]))
    const seek = byMethod.get('seek')!
    const seconds = strictCodec(seek.parameters[0]!.codec, 'seek:seconds')
    expect(seconds.create().parse(12.5)).toBe(12.5)

    const mute = strictCodec(byMethod.get('setMute')!.parameters[0]!.codec, 'setMute:mute')
    expect(mute.create().parse(true)).toBe(true)

    const addMusic = byMethod.get('addMusic')!
    expect(strictCodec(addMusic.parameters[1]!.codec, 'addMusic:position').create().parse('next')).toBe('next')
  })

  it('descriptor 满足 wire 层校验规则（id/wire 名/唯一性/sourceLocation）', () => {
    const ids = new Set<string>()
    const methods = new Set<string>()
    for (const descriptor of LXP_REMOTE_CONTRIBUTION.descriptors) {
      expect(descriptor.id.length).toBeGreaterThan(0)
      expect(ids.has(descriptor.id)).toBe(false)
      ids.add(descriptor.id)
      expect(methods.has(descriptor.method)).toBe(false)
      methods.add(descriptor.method)

      expect(WIRE_NAME.test(descriptor.service)).toBe(true)
      expect(WIRE_NAME.test(descriptor.namespace)).toBe(true)
      expect(WIRE_NAME.test(descriptor.method)).toBe(true)
      expect(descriptor.invocation.kind).toBe('direct')

      // 位置参数一律走 JSON（host 端 SRC fallback 不接受 lookup）。
      const wires = new Set<string>()
      for (const parameter of descriptor.parameters) {
        expect(WIRE_NAME.test(parameter.name)).toBe(true)
        expect(WIRE_NAME.test(parameter.wire)).toBe(true)
        expect(wires.has(parameter.wire)).toBe(false)
        wires.add(parameter.wire)
        expect(parameter.source).toBe('json')
      }

      const location = descriptor.sourceLocation
      if (location === undefined) throw new Error(`${descriptor.method}: 缺少 sourceLocation`)
      expect(Number.isInteger(location.line)).toBe(true)
      expect(location.line).toBeGreaterThanOrEqual(1)
      expect(Number.isInteger(location.column)).toBe(true)
      expect(location.column).toBeGreaterThanOrEqual(1)
    }
    expect(LXP_REMOTE_CONTRIBUTION.package).toBe('lx-music-for-dsh')
  })

  it('与 PlaybackService 的 @Remote 方法双向一致（方法名 + 参数个数）', () => {
    const service = new PlaybackService(new Context(), {
      settings: { ...DEFAULT_SETTINGS, providerMode: 'mock' },
    })
    const markers = remoteMethods(service)
    expect(markers.length).toBeGreaterThan(0)

    const exported = markers.map((marker) => marker.exportName ?? marker.method)
    const described = LXP_REMOTE_CONTRIBUTION.descriptors.map((d) => d.method)
    expect([...described].sort().join(',')).toBe([...exported].sort().join(','))

    const instance = service as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const descriptor of LXP_REMOTE_CONTRIBUTION.descriptors) {
      const fn = instance[descriptor.method]
      expect(typeof fn).toBe('function')
      // wire 按 descriptor.parameters 逐位解析：个数必须与 host 方法形参一致
      // （playback.ts 的 @Remote 方法因此不允许带默认值的形参）。
      expect(descriptor.parameters.length).toBe(fn!.length)
    }
  })
})
