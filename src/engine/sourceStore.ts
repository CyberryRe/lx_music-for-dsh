// 本地音源存储：音源脚本持久化（storage domain 'sources' 表 / 'source_order' 表，内存兜底）。

export interface SourceRecord {
  id: string
  name: string
  version?: string
  author?: string
  description?: string
  homepage?: string
  script: string
  enabled: boolean
  supportedSources?: string[]
  sourceUrl?: string
  createdAt: string
  updatedAt: string
  lastError?: string
}

export interface SourceStoreFace {
  list(): SourceRecord[]
  get(id: string): SourceRecord | undefined
  put(record: SourceRecord): Promise<void>
  remove(id: string): Promise<boolean>
  order(): string[]
  setOrder(ids: string[]): Promise<void>
}

/** 内存实现（无 storage 时兜底）。 */
export class MemorySourceStore implements SourceStoreFace {
  private records = new Map<string, SourceRecord>()
  private ids: string[] = []

  list(): SourceRecord[] {
    return this.ids.map((id) => this.records.get(id)).filter((r): r is SourceRecord => r !== undefined)
  }
  get(id: string): SourceRecord | undefined {
    return this.records.get(id)
  }
  async put(record: SourceRecord): Promise<void> {
    if (!this.records.has(record.id)) this.ids.push(record.id)
    this.records.set(record.id, record)
  }
  async remove(id: string): Promise<boolean> {
    const existed = this.records.delete(id)
    this.ids = this.ids.filter((x) => x !== id)
    return existed
  }
  order(): string[] {
    return this.ids
  }
  async setOrder(ids: string[]): Promise<void> {
    const known = new Set(this.records.keys())
    this.ids = ids.filter((id) => known.has(id))
    for (const id of this.records.keys()) {
      if (!this.ids.includes(id)) this.ids.push(id)
    }
  }
}

/** storage domain 实现。 */
export class DomainSourceStore implements SourceStoreFace {
  private readonly sourceTable: ReturnType<StorageFace['table']>
  private readonly orderTable: ReturnType<StorageFace['table']>
  private readonly memory = new MemorySourceStore()

  /**
   * @param storage - storage domain 门面。
   * @param options.legacyFile - 旧版文件存储路径（`$DSH_HOME/storages/lx-music-sources.json`）。
   *   1.0.0 的 domain schema 与实际写入形状不一致，storage domain 每次 open 都以
   *   `invalid-record` 失败并降级到该文件；1.0.1 修好 schema 后，domain 里的音源快照会比
   *   文件里的旧。传入此路径做一次性合并（缺失或更新的记录才写入），避免修 bug 反而让
   *   用户当前在用的音源消失。
   */
  constructor(storage: StorageFace, options: { legacyFile?: string } = {}) {
    this.sourceTable = storage.table('sources')
    this.orderTable = storage.table('source_order')
    // 启动时从持久层装载到内存
    for (const [, value] of this.sourceTable.entries()) {
      const record = value as SourceRecord
      if (record && typeof record.id === 'string') {
        void this.memory.put(record)
      }
    }
    const order = this.orderTable.get('order') as string[] | undefined
    if (Array.isArray(order) && order.length > 0) void this.memory.setOrder(order)
    if (options.legacyFile) this.mergeLegacyFile(options.legacyFile)
  }

  /**
   * 一次性合并旧版文件存储：只在 domain 里没有该 id、或文件里的 `updatedAt` 更新时写入；
   * 合并后把文件改名（`.migrated-<时间戳>`）作为"已迁移"标记 —— 否则用户删掉的音源会在
   * 下次启动时被旧文件复活。写入失败只告警，不影响启动。
   *
   * 内存部分的合并**同步**完成（`MemorySourceStore` 的方法体没有 await），因为
   * `EngineProvider` 构造函数紧接着就 `void this.reload()` 读 `store.list()`；若把内存
   * 合并也推到微任务里，首次加载会漏掉刚迁移过来的音源脚本。落盘与改名异步收尾。
   * @param file - 旧版文件存储的绝对路径。
   */
  private mergeLegacyFile(file: string): void {
    if (!existsSync(file)) return
    let data: { records?: SourceRecord[]; order?: string[] }
    try {
      data = JSON.parse(readFileSync(file, 'utf8')) as { records?: SourceRecord[]; order?: string[] }
    } catch {
      return
    }
    const records = Array.isArray(data.records) ? data.records : []
    if (records.length === 0) return
    const adopted: string[] = []
    const writes: Promise<unknown>[] = []
    for (const record of records) {
      if (!record || typeof record.id !== 'string') continue
      const existing = this.memory.get(record.id)
      const ours = String(existing?.updatedAt ?? '')
      const theirs = String(record.updatedAt ?? '')
      if (existing !== undefined && ours >= theirs) continue
      void this.memory.put(record)
      writes.push(this.sourceTable.put(record.id, record).catch(() => undefined))
      adopted.push(record.id)
    }
    if (adopted.length > 0) {
      const fileOrder = (Array.isArray(data.order) ? data.order : []).filter((id) => this.memory.get(id) !== undefined)
      const known = new Set(this.memory.order())
      const next = [...fileOrder, ...this.memory.order()].filter((id, index, all) => known.has(id) && all.indexOf(id) === index)
      void this.memory.setOrder(next)
      writes.push(this.orderTable.put('order', this.memory.order()).catch(() => undefined))
      console.warn(`[lx-music] 已从文件存储合并 ${String(adopted.length)} 个音源到 storage domain: ${adopted.join(', ')}`)
    }
    void Promise.all(writes)
      .then(() => {
        try {
          renameSync(file, `${file}.migrated-${String(Date.now())}`)
        } catch (err) {
          console.warn('[lx-music] 迁移标记写入失败（下次启动会重新合并一次）:', err)
        }
      })
      .catch((err: unknown) => console.warn('[lx-music] 旧文件存储迁移失败:', err))
  }

  list(): SourceRecord[] {
    return this.memory.list()
  }
  get(id: string): SourceRecord | undefined {
    return this.memory.get(id)
  }
  async put(record: SourceRecord): Promise<void> {
    await this.memory.put(record)
    await this.sourceTable.put(record.id, record).catch(() => undefined)
    await this.orderTable.put('order', this.memory.order()).catch(() => undefined)
  }
  async remove(id: string): Promise<boolean> {
    const existed = await this.memory.remove(id)
    if (existed) {
      await this.sourceTable.delete(id).catch(() => undefined)
      await this.orderTable.put('order', this.memory.order()).catch(() => undefined)
    }
    return existed
  }
  order(): string[] {
    return this.memory.order()
  }
  async setOrder(ids: string[]): Promise<void> {
    await this.memory.setOrder(ids)
    await this.orderTable.put('order', this.memory.order()).catch(() => undefined)
  }
}

/** 文件实现：直接持久化到 JSON 文件（原子写），不依赖 dsh storageDomain。
 *  用于 storage domain 打开失败或未注入时保证音源重启不丢。 */
export class FileSourceStore implements SourceStoreFace {
  private readonly file: string
  private readonly memory = new MemorySourceStore()
  private writeChain: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.file = file
    this.load()
  }

  private load(): void {
    try {
      const text = readFileSync(this.file, 'utf8')
      const data = JSON.parse(text) as { records?: SourceRecord[]; order?: string[] }
      for (const record of data.records ?? []) {
        if (record && typeof record.id === 'string') {
          void this.memory.put(record)
        }
      }
      if (Array.isArray(data.order)) void this.memory.setOrder(data.order)
    } catch {
      // 文件不存在或损坏：从空开始（首次写入会重建）
    }
  }

  list(): SourceRecord[] {
    return this.memory.list()
  }
  get(id: string): SourceRecord | undefined {
    return this.memory.get(id)
  }
  async put(record: SourceRecord): Promise<void> {
    await this.memory.put(record)
    await this.persist()
  }
  async remove(id: string): Promise<boolean> {
    const existed = await this.memory.remove(id)
    if (existed) await this.persist()
    return existed
  }
  order(): string[] {
    return this.memory.order()
  }
  async setOrder(ids: string[]): Promise<void> {
    await this.memory.setOrder(ids)
    await this.persist()
  }

  /** 串行化原子写：tmp 文件 + rename（对齐 dsh-storage-json 的发布协议）。 */
  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ records: this.memory.list(), order: this.memory.order() }, null, 2)
    this.writeChain = this.writeChain
      .then(async () => {
        await mkdir(dirname(this.file), { recursive: true })
        const tmp = join(dirname(this.file), `.${basename(this.file)}.${process.pid}.${Date.now()}.tmp`)
        await writeFile(tmp, snapshot, 'utf8')
        await rename(tmp, this.file)
      })
      .catch((err) => {
        console.warn('[lx-music] 音源持久化写入失败:', err)
      })
    return this.writeChain
  }
}

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { StorageFace } from '../playback'
