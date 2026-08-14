// provider 选择逻辑与 mock 音源管理门面测试。

import { describe, expect, it } from './mini'
import { createProvider, LxProviderFacade, MockSourceFacade, migrateMockMode } from '../src/provider'
import { MockProvider } from '../src/mock'

describe('createProvider', () => {
  it('providerMode=engine 返回内置引擎（默认独立模式）', () => {
    const p = createProvider({ lxServerUrl: 'http://x', providerMode: 'engine' })
    expect(p.mode).toBe('engine')
  })

  it('providerMode=mock 返回 mock', () => {
    const p = createProvider({ lxServerUrl: 'http://x', providerMode: 'mock' })
    expect(p.mode).toBe('mock')
  })

  it('providerMode=lxserver 且无地址抛错', () => {
    expect(() => createProvider({ lxServerUrl: '', providerMode: 'lxserver' })).toThrow('lxServerUrl')
  })

  it('providerMode=lxserver 且有地址返回 lxserver', () => {
    const p = createProvider({ lxServerUrl: 'http://127.0.0.1:23332', providerMode: 'lxserver' })
    expect(p.mode).toBe('lxserver')
  })

  it('auto + 有地址 → lxserver；无地址 → 内置引擎', () => {
    expect(createProvider({ lxServerUrl: 'http://127.0.0.1:23332', providerMode: 'auto' }).mode).toBe('lxserver')
    expect(createProvider({ lxServerUrl: '', providerMode: 'auto' }).mode).toBe('engine')
  })
})

describe('migrateMockMode 旧值迁移', () => {
  it('旧 mockMode 值映射到新 providerMode', () => {
    expect(migrateMockMode('on')).toBe('mock')
    expect(migrateMockMode('off')).toBe('lxserver')
    expect(migrateMockMode('auto')).toBe('auto')
    expect(migrateMockMode('engine')).toBe('engine')
    expect(migrateMockMode(undefined)).toBe('auto')
  })
})

describe('MockSourceFacade 音源管理', () => {
  it('validate 拒绝无 inited 的脚本', async () => {
    const f = new MockSourceFacade(new MockProvider({ latencyMs: 0 }))
    const r = (await f.validateSource('var x = 1')) as { valid: boolean }
    expect(r.valid).toBe(false)
  })

  it('validate 通过合法脚本并返回元数据', async () => {
    const f = new MockSourceFacade(new MockProvider({ latencyMs: 0 }))
    const script = `/**
 * @name 测试源
 * @version 1.0.0
 */
lx.send('inited', { sources: { wy: {} } })`
    const r = (await f.validateSource(script)) as { valid: boolean; metadata?: { name?: string } }
    expect(r.valid).toBe(true)
    expect(r.metadata?.name).toBe('测试源')
  })

  it('upload → toggle → list → delete 全流程', async () => {
    const f = new MockSourceFacade(new MockProvider({ latencyMs: 0 }))
    const script = `/** @name 我的源 */ lx.send('inited', { sources: { wy: {} } })`
    const up = await f.uploadSource('my.js', script)
    expect(up.success).toBe(true)
    expect(up.id).toBe('我的源.js')
    let list = await f.listSources()
    expect(list).toHaveLength(1)
    expect(list[0]?.enabled).toBe(true) // 导入后自动启用
    await f.toggleSource(up.id!, false)
    list = await f.listSources()
    expect(list[0]?.enabled).toBe(false)
    await f.reorderSources([up.id!])
    await f.deleteSource(up.id!)
    expect(await f.listSources()).toHaveLength(0)
  })
})

describe('LxProviderFacade', () => {
  it('mode 标记为 lxserver', () => {
    const f = new LxProviderFacade({ baseUrl: 'http://x', searchWithFallback: async () => ({ results: [], usedSource: null, attempts: [] }), resolveUrl: async () => ({ url: '', type: '128k' }), listSources: async () => [], validateSource: async () => ({}), uploadSource: async () => ({ success: false }), importSource: async () => ({ success: false }), toggleSource: async () => ({ success: false }), deleteSource: async () => ({ success: false }), reorderSources: async () => ({ success: false }), ping: async () => false } as never)
    expect(f.mode).toBe('lxserver')
  })
})
