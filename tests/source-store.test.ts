// FileSourceStore：音源持久化（重启不丢）回归测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs'
import { DomainSourceStore, FileSourceStore, type SourceRecord } from '../src/engine/sourceStore'
import type { StorageFace } from '../src/playback'

function record(id: string, name: string): SourceRecord {
  return { id, name, script: `/* @name ${name} */ lx.send('inited', { sources: {} })`, enabled: true, createdAt: '2026-08-15T00:00:00.000Z', updatedAt: '2026-08-15T00:00:00.000Z' }
}

let dir: string
test.before(() => {
  dir = mkdtempSync(join(tmpdir(), 'lx-source-store-'))
})
test.after(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('put 后新实例（模拟重启）仍能读到音源', async () => {
  const file = join(dir, 'sources.json')
  const store = new FileSourceStore(file)
  await store.put(record('a.js', 'Alpha'))
  await store.put(record('b.js', 'Beta'))
  await store.setOrder(['b.js', 'a.js'])

  // 模拟重启：重新从磁盘加载
  const reloaded = new FileSourceStore(file)
  assert.deepEqual(reloaded.list().map((r) => r.id), ['b.js', 'a.js'])
  assert.equal(reloaded.get('a.js')?.name, 'Alpha')
  assert.equal(reloaded.get('a.js')?.script.includes('Alpha'), true)
})

test('remove 与顺序持久化', async () => {
  const file = join(dir, 'sources2.json')
  const store = new FileSourceStore(file)
  await store.put(record('x.js', 'X'))
  await store.put(record('y.js', 'Y'))
  await store.remove('x.js')
  await store.setOrder(['y.js'])

  const reloaded = new FileSourceStore(file)
  assert.deepEqual(reloaded.list().map((r) => r.id), ['y.js'])
})

test('文件内容为合法 JSON（原子写产物）', async () => {
  const file = join(dir, 'sources3.json')
  const store = new FileSourceStore(file)
  await store.put(record('z.js', 'Z'))
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as { records: SourceRecord[]; order: string[] }
  assert.equal(parsed.records.length, 1)
  assert.equal(parsed.records[0]!.id, 'z.js')
  assert.deepEqual(parsed.order, ['z.js'])
  // 无残留 tmp 文件
  const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
})

// ── DomainSourceStore：1.0.0 → 1.0.1 的一次性文件合并迁移 ──────────────────────
// 背景：1.0.0 的 storage domain schema 有缺陷（source_order 声明为对象、实际写入裸数组），
// `open` 每次都因 invalid-record 失败并降级到 FileSourceStore。修好 schema 后，domain 里的
// 音源快照比文件旧；如果直接切换，用户当前在用的音源会"消失"。因此 DomainSourceStore
// 构造时会做一次性合并（缺失或 updatedAt 更新的记录才写入），并把文件改名标记已迁移。

/** 最小 storage domain 门面（内存实现），记录调用以便断言写回。 */
function fakeStorage(): StorageFace & { globalValue: { current: unknown }; tables: Map<string, Map<string, unknown>> } {
  const tables = new Map<string, Map<string, unknown>>()
  const state = { current: undefined as unknown }
  return {
    globalValue: { get current() { return state.current }, set current(v: unknown) { state.current = v } },
    tables,
    global: {
      get: () => state.current,
      set: async (v: unknown) => { state.current = v },
    },
    table: (name: string) => {
      if (!tables.has(name)) tables.set(name, new Map())
      const t = tables.get(name)!
      return {
        get: (k: string) => t.get(k),
        put: async (k: string, v: unknown) => { t.set(k, v) },
        entries: () => t.entries(),
        delete: async (k: string) => t.delete(k),
      }
    },
  }
}

test('DomainSourceStore：把旧文件存储里的音源合并进 domain（不丢当前在用的音源）', async () => {
  const legacy = join(dir, 'legacy-sources.json')
  writeFileSync(legacy, JSON.stringify({
    records: [
      // domain 里没有 → 必须被采纳
      { ...record('xinghai.js', '星海音乐源'), updatedAt: '2026-08-16T06:03:12.391Z' },
      // domain 里已有且更新 → 保留 domain 版本
      { ...record('old.js', '文件里的旧记录'), updatedAt: '2026-01-01T00:00:00.000Z' },
    ],
    order: ['xinghai.js', 'old.js'],
  }), 'utf8')

  const storage = fakeStorage()
  await storage.table('sources').put('old.js', { ...record('old.js', 'domain 里的新记录'), updatedAt: '2026-09-01T00:00:00.000Z' })

  const store = new DomainSourceStore(storage, { legacyFile: legacy })
  // 合并是异步的（构造函数不能 await）：等待写入链落地
  await new Promise((r) => setTimeout(r, 50))

  assert.equal(store.get('xinghai.js')?.name, '星海音乐源')
  assert.equal(store.get('old.js')?.name, 'domain 里的新记录')
  assert.equal(storage.tables.get('sources')?.get('xinghai.js') !== undefined, true)
  // 顺序合并后 xinghai 在 old 之前
  assert.deepEqual(store.order(), ['xinghai.js', 'old.js'])
  // 已迁移标记：文件被改名，避免用户删除音源后被旧文件复活
  assert.equal(existsSync(legacy), false)
  assert.equal(readdirSync(dir).some((f) => f.startsWith('legacy-sources.json.migrated-')), true)
})

test('DomainSourceStore：不传 legacyFile 时不做任何合并', async () => {
  const storage = fakeStorage()
  await storage.table('sources').put('a.js', record('a.js', 'A'))
  const store = new DomainSourceStore(storage)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(store.list().map((r) => r.id), ['a.js'])
})
