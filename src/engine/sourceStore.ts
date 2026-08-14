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

  constructor(storage: StorageFace) {
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

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { StorageFace } from '../playback'
