// 自带 skill 的测试：定义形状、注册路径、以及**正文长度预算**（它只在被触发时加载，
// 但仍然是 token，太长就违背了"指令放 skill 正文"的初衷）。
import { describe, expect, it } from './mini'
import { Context, Service } from '@deepseek-ai/cordis'
import { TASTE_SKILL, TASTE_SKILL_CONTENT, TASTE_SKILL_NAME } from '../src/taste/skill'
import { apply } from '../src/index'

describe('skill 定义', () => {
  it('名字是 kebab-case（DSH 的寻址要求）', () => {
    expect(TASTE_SKILL_NAME).toBe(TASTE_SKILL_NAME.toLowerCase())
    expect(/^[a-z][a-z0-9-]*$/.test(TASTE_SKILL_NAME)).toBe(true)
    expect(TASTE_SKILL.name).toBe(TASTE_SKILL_NAME)
  })

  it('描述能用于路由（提到两个关键工具）', () => {
    expect(TASTE_SKILL.description).toContain('music_profile')
    expect(TASTE_SKILL.description).toContain('music_play_song')
    expect(TASTE_SKILL.description.length).toBeGreaterThan(10)
    expect(TASTE_SKILL.description.length).toBeLessThan(200)
  })

  it('正文把流程写全：查画像 → 挑确定的歌 → 精确播放 → 探索模式 → 顺手记喜好', () => {
    for (const token of ['music_profile', 'music_play_song', 'music_taste', 'mode:"explore"', 'for-mood', 'explore-brief']) {
      expect(TASTE_SKILL_CONTENT).toContain(token)
    }
  })

  it('正文明确"不要用模糊词搜索"（这是产品的核心主张）', () => {
    expect(TASTE_SKILL_CONTENT).toContain('模糊')
  })

  it('正文有长度预算（skill 只在触发时加载，但仍然要控制 token）', () => {
    expect(TASTE_SKILL_CONTENT.length).toBeLessThan(1600)
    expect(TASTE_SKILL_CONTENT.length).toBeGreaterThan(200)
  })

  it('带 source 元数据（DSH 要求的来源桶）', () => {
    expect(TASTE_SKILL.source).toBe('runtime')
  })
})

describe('apply 的 skill 注册路径', () => {
  /** 真实的 skills 服务（走 cordis 的作用域注入，而不是伪造 inject）。 */
  class FakeSkills extends Service {
    readonly registered: unknown[] = []
    constructor(ctx: Context) {
      super(ctx, 'skills')
    }
    register(skill: unknown): () => void {
      this.registered.push(skill)
      return () => {}
    }
  }

  function makeCtx(): { ctx: Parameters<typeof apply>[0]; tools: unknown[]; skills: FakeSkills; warnings: unknown[][] } {
    const base = new Context()
    const skills = new FakeSkills(base)
    const tools: unknown[] = []
    const warnings: unknown[][] = []
    const ctx = base as unknown as Parameters<typeof apply>[0] & {
      tools: { register(t: unknown): void }
      logger: { warn(...a: unknown[]): void }
    }
    ctx.tools = { register: (t) => void tools.push(t) }
    ctx.logger = { warn: (...a) => void warnings.push(a) }
    return { ctx, tools, skills, warnings }
  }

  it('画像默认关闭 → 不注册 skill（实验性功能不主动暴露给模型）', async () => {
    const { ctx, skills, tools } = makeCtx()
    await apply(ctx, { providerMode: 'mock', migrateLegacyDomain: false })
    // 注入是异步作用域回调，给它一个宏任务落地
    await new Promise((r) => setImmediate(r))
    expect(skills.registered).toHaveLength(0)
    expect(tools.length).toBeGreaterThan(0)
  })

  it('skill 跟着画像开关走：开启即注册、关闭即撤下（无需重启）', async () => {
    const base = new Context()
    class FakeSkills extends Service {
      registered: unknown[] = []
      constructor(ctx: Context) {
        super(ctx, 'skills')
      }
      register(skill: unknown): () => void {
        this.registered.push(skill)
        return () => {
          this.registered = this.registered.filter((s) => s !== skill)
        }
      }
    }
    const skills = new FakeSkills(base)
    // 画像配置存在存储的 global 里，所以要先给一个可用的 storageDomain
    const globalStore = new Map<string, unknown>()
    const tables = new Map<string, Map<string, unknown>>()
    ;(base as unknown as { provide(name: string, value: unknown): void }).provide('storageDomain', {
      open: async () => ({
        global: { get: () => globalStore.get('state'), set: async (v: unknown) => void globalStore.set('state', v) },
        table: (name: string) => {
          if (!tables.has(name)) tables.set(name, new Map())
          const t = tables.get(name)!
          return { get: (k: string) => t.get(k), put: async (k: string, v: unknown) => void t.set(k, v), entries: () => t.entries(), delete: async (k: string) => t.delete(k) }
        },
      }),
    })
    const tools: unknown[] = []
    const ctx = base as unknown as Parameters<typeof apply>[0] & { tools: { register(t: unknown): void }; logger: { warn(): void } }
    ctx.tools = { register: (t) => void tools.push(t) }
    ctx.logger = { warn: (): void => {} }

    await apply(ctx, { providerMode: 'mock', migrateLegacyDomain: false })
    // 等存储挂载 + 两个作用域注入落地
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5))
    expect(skills.registered).toHaveLength(0) // 默认关闭

    const service = (base as unknown as { lxPlayback: { setMemoryConfig(req: { patch: { enabled?: boolean } }): Promise<unknown> } }).lxPlayback
    await service.setMemoryConfig({ patch: { enabled: true } })
    expect(skills.registered).toHaveLength(1)
    expect((skills.registered[0] as { name: string }).name).toBe(TASTE_SKILL_NAME)

    await service.setMemoryConfig({ patch: { enabled: false } })
    expect(skills.registered).toHaveLength(0)
  })

  it('没有 skills 服务时 apply 仍然正常完成（不因注入缺失而失败）', async () => {
    const base = new Context()
    const tools: unknown[] = []
    const ctx = base as unknown as Parameters<typeof apply>[0] & { tools: { register(t: unknown): void }; logger: { warn(): void } }
    ctx.tools = { register: (t) => void tools.push(t) }
    ctx.logger = { warn: (): void => {} }
    await apply(ctx, { providerMode: 'mock', migrateLegacyDomain: false })
    expect(tools.length).toBeGreaterThan(0)
  })

  it('skill 注册抛错被吞掉并告警（不能拖垮插件）', async () => {
    const base = new Context()
    class BrokenSkills extends Service {
      constructor(ctx: Context) {
        super(ctx, 'skills')
      }
      register(): () => void {
        throw new Error('registry full')
      }
    }
    new BrokenSkills(base)
    const warnings: unknown[][] = []
    const ctx = base as unknown as Parameters<typeof apply>[0] & { tools: { register(t: unknown): void }; logger: { warn(...a: unknown[]): void } }
    ctx.tools = { register: (): void => {} }
    ctx.logger = { warn: (...a) => void warnings.push(a) }
    await apply(ctx, { providerMode: 'mock', migrateLegacyDomain: false })
    await new Promise((r) => setImmediate(r))
    expect(warnings.length).toBeGreaterThan(0)
  })
})
