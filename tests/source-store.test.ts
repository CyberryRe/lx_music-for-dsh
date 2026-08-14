// FileSourceStore：音源持久化（重启不丢）回归测试
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs'
import { FileSourceStore, type SourceRecord } from '../src/engine/sourceStore'

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
