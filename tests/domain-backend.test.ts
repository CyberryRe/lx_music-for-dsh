// 真实 JSON backend 的存储行为测试（回归锁）。
//
// 为什么要用真实 backend 而不是 fake：1.2.0 把 domain 从 `single` 换成 `per-record`，
// 并声明 `invalidRecords: 'backup-and-skip'`。这两条的价值只在 backend 的真实落盘行为里
// 才成立（见 docs/design-taste-memory.md §2 的 spike 结论）：
//   - per-record + backup-and-skip → 坏记录被改名备份，open 存活；
//   - single + 任何选项 → 一条坏记录让整个 open 以 invalid-record 失败（1.0.1 的事故机制）。
// 如果将来 DSH 改了这套语义，这个测试会先失败，而不是等用户丢数据。
//
// 依赖 @deepseek-ai/dsh-storage / dsh-storage-json / dsh-storage-domain / cordis。
// 这些包在插件宿主里必然存在；在极简环境里缺失时优雅跳过（契约测试仍守着声明本身）。

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { describe, expect, it } from './mini'

interface DomainHandle {
  global: { get(): unknown; set(v: unknown): Promise<void> }
  table(name: string): { keys(): Iterable<string>; put(k: string, v: unknown): Promise<void> }
  close(): Promise<void>
}

interface StorageStack {
  openDomain: (layout: 'single' | 'per-record', invalidRecords: boolean, root: string) => Promise<DomainHandle>
}

async function loadStorageStack(): Promise<StorageStack | undefined> {
  try {
    const [cordis, storage, storageJson, domainPkg] = await Promise.all([
      import('@deepseek-ai/cordis'),
      import('@deepseek-ai/dsh-storage'),
      import('@deepseek-ai/dsh-storage-json'),
      import('@deepseek-ai/dsh-storage-domain'),
    ])
    const Context = (cordis as unknown as { Context: new () => Record<string, unknown> }).Context
    const hub = (storage as unknown as { Storage?: unknown; default?: unknown }).Storage ?? (storage as unknown as { default: unknown }).default
    const backend = storageJson as unknown as { name: string; inject: string[]; Config: unknown; apply: unknown }
    const dom = domainPkg as unknown as { name: string; inject: string[]; Config: unknown; apply: unknown; defineDomain: unknown; domainTable: unknown }
    const defineDomain = dom.defineDomain as (spec: unknown) => unknown
    const domainTable = dom.domainTable as (schema: unknown) => unknown

    return {
      openDomain: async (layout, invalidRecords, root) => {
        const ctx = new Context() as Record<string, unknown> & { storageDomain?: { open(spec: unknown): Promise<DomainHandle> } }
        const plugin = (m: { name: string; inject: string[]; Config: unknown; apply: unknown }, config: unknown): void => {
          ;(ctx as unknown as { plugin(p: unknown, c?: unknown): void }).plugin({ name: m.name, inject: m.inject, Config: m.Config, apply: m.apply }, config)
        }
        ;(ctx as unknown as { plugin(p: unknown): void }).plugin(hub)
        plugin(backend, { root })
        plugin(dom, { backend: 'json' })
        for (let i = 0; i < 100 && !ctx.storageDomain; i++) await new Promise((r) => setTimeout(r, 20))
        if (!ctx.storageDomain) throw new Error('storageDomain 未就绪')
        const spec = defineDomain({
          name: 'lx_music',
          version: 1,
          layout,
          ...(invalidRecords ? { invalidRecords: 'backup-and-skip' } : {}),
          global: { schema: z.object({ note: z.string().optional() }), initial: { note: 'init' } },
          tables: { items: domainTable(z.object({ v: z.number() })) },
        })
        return ctx.storageDomain.open(spec)
      },
    }
  } catch {
    return undefined
  }
}

function withRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'lx-domain-'))
  return fn(root).finally(() => rmSync(root, { recursive: true, force: true }))
}

describe('storage domain 落盘行为（真实 JSON backend）', () => {
  it('per-record + backup-and-skip：坏记录被备份并跳过，open 存活且幂等', async () => {
    const stack = await loadStorageStack()
    if (!stack) {
      console.log('[skip] 真实存储栈不可用（缺少 @deepseek-ai/dsh-storage-json 等）')
      return
    }
    await withRoot(async (root) => {
      // 1. 正常写入两条
      const dom = await stack.openDomain('per-record', true, root)
      await dom.table('items').put('k1', { v: 1 })
      await dom.table('items').put('k2', { v: 2 })
      await dom.close()

      // 2. 一条一文件：确认落盘形状确实是 per-record（否则本测试的前提不成立）
      const itemsDir = join(root, 'lx_music', 'items')
      expect(existsSync(itemsDir)).toBe(true)
      expect(readdirSync(itemsDir).sort()).toEqual(['k1.json', 'k2.json'])

      // 3. 把 k2 改成 schema 不合法的值
      writeFileSync(join(itemsDir, 'k2.json'), JSON.stringify({ version: 1, record: { v: 'NOT-A-NUMBER' } }))

      // 4. 重新打开：必须存活，坏记录被改名备份
      const reopened = await stack.openDomain('per-record', true, root)
      expect([...reopened.table('items').keys()]).toEqual(['k1'])
      const after = readdirSync(itemsDir).sort()
      expect(after.some((f) => f.startsWith('k2.json.bak.'))).toBe(true)
      const backup = after.find((f) => f.startsWith('k2.json.bak.'))
      expect(backup).toBeTruthy()
      if (backup) {
        const doc = JSON.parse(readFileSync(join(itemsDir, backup), 'utf8')) as { record: { v: unknown } }
        expect(doc.record.v).toBe('NOT-A-NUMBER')
      }
      await reopened.close()

      // 5. 幂等：再开一次不重复备份、结果稳定
      const again = await stack.openDomain('per-record', true, root)
      expect([...again.table('items').keys()]).toEqual(['k1'])
      expect(readdirSync(itemsDir).filter((f) => f.startsWith('k2.json.bak.')).length).toBe(1)
      await again.close()
    })
  })

  it('single 布局下同一条坏记录会让整个 open 失败（这正是 1.2.0 要离开 single 的原因）', async () => {
    const stack = await loadStorageStack()
    if (!stack) {
      console.log('[skip] 真实存储栈不可用')
      return
    }
    await withRoot(async (root) => {
      const dom = await stack.openDomain('single', false, root)
      await dom.table('items').put('k1', { v: 1 })
      await dom.table('items').put('k2', { v: 2 })
      await dom.close()

      const file = join(root, 'lx_music.json')
      expect(existsSync(file)).toBe(true)
      const doc = JSON.parse(readFileSync(file, 'utf8')) as { tables: { items: Record<string, unknown> } }
      doc.tables.items.k2 = { v: 'NOT-A-NUMBER' }
      writeFileSync(file, JSON.stringify(doc))

      // 即使声明 backup-and-skip，single 布局也无法"把单条记录挪走" → 仍然失败
      await expect(stack.openDomain('single', true, root)).rejects.toThrow(/invalid-record|does not match/)
    })
  })
})
