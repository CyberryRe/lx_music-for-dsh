// 本地音源存储：音源脚本持久化（storage domain 'sources' 表 / 'source_order' 表，内存兜底）。

import { existsSync, readFileSync, renameSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { storageKey } from '../storage/keys'
import type { StorageFace } from '../playback'

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
  /** 是否写到"重启后还在"的持久层（诊断用：storage domain / 文件 = true）。 */
  isDurable(): boolean
  /** 持久层种类（诊断用，进插件状态文件）。 */
  kind(): 'domain' | 'file' | 'memory'
}

/**
 * 写入失败回调。
 *
 * 为什么必须有：这两个 store 过去对所有写失败 `catch(() => undefined)`，于是
 * "导入成功"的 UI 反馈与"其实一条都没落盘"同时成立——用户重启 DSH 后音源消失，
 * 而插件状态文件里全是 durable/ok，无从判断。现在失败会向上抛（put 成功才返回
 * success），同时通过这个回调留下一行可诊断的日志。
 */
export interface SourceStoreOptions {
  onError?: (message: string, error: unknown) => void
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
  isDurable(): boolean {
    return false
  }
  kind(): 'memory' {
    return 'memory'
  }
}

/** storage domain 实现。 */
export class DomainSourceStore implements SourceStoreFace {
  private readonly sourceTable: ReturnType<StorageFace['table']>
  private readonly orderTable: ReturnType<StorageFace['table']>
  private readonly memory = new MemorySourceStore()
  private readonly onError?: SourceStoreOptions['onError']

  /**
   * @param storage - storage domain 门面。
   * @param options.legacyFile - 旧版文件存储路径（`$DSH_HOME/storages/lx-music-sources.json`）。
   *   1.0.0 的 domain schema 与实际写入形状不一致，storage domain 每次 open 都以
   *   `invalid-record` 失败并降级到该文件；1.0.1 修好 schema 后，domain 里的音源快照会比
   *   文件里的旧。传入此路径做一次性合并（缺失或更新的记录才写入），避免修 bug 反而让
   *   用户当前在用的音源消失。
   * @param options.onError - 持久化失败回调（主写失败会向上抛，这里只留诊断日志）。
   */
  constructor(storage: StorageFace, options: { legacyFile?: string } & SourceStoreOptions = {}) {
    this.sourceTable = storage.table('sources')
    this.orderTable = storage.table('source_order')
    this.onError = options.onError
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

  /** 持久化失败：留日志（不给调用方吞掉的机会，主写会另行抛错）。 */
  private fail(message: string, error: unknown): void {
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    this.onError?.(`${message}: ${detail}`, error)
  }

  /**
   * 顺序表写回（非致命）：顺序只影响音源优先级，写不进去不该让一次成功的导入失败；
   * 但仍要留日志，避免"顺序莫名其妙变了"变成无解之谜。
   */
  private async writeOrder(): Promise<void> {
    try {
      await this.orderTable.put('order', this.memory.order())
    } catch (err) {
      this.fail('音源顺序写回失败（不影响音源本身）', err)
    }
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
      // ⚠️ 不能吞掉写失败：下面的改名是"已迁移"标记，若写其实没成功却把文件改名，
      // 用户的音源就真的没了（旧实现在这里也吞错，属于同一类静默数据丢失）。
      writes.push(this.sourceTable.put(storageKey(record.id), record))
      adopted.push(record.id)
    }
    if (adopted.length > 0) {
      const fileOrder = (Array.isArray(data.order) ? data.order : []).filter((id) => this.memory.get(id) !== undefined)
      const known = new Set(this.memory.order())
      const next = [...fileOrder, ...this.memory.order()].filter((id, index, all) => known.has(id) && all.indexOf(id) === index)
      void this.memory.setOrder(next)
      writes.push(this.orderTable.put('order', this.memory.order()))
      console.warn(`[lx-music] 已从文件存储合并 ${String(adopted.length)} 个音源到 storage domain: ${adopted.join(', ')}`)
    }
    void Promise.all(writes)
      .then(() => {
        try {
          renameSync(file, `${file}.migrated-${String(Date.now())}`)
        } catch (err) {
          this.fail('迁移标记写入失败（下次启动会重新合并一次）', err)
        }
      })
      .catch((err: unknown) => {
        // 保留原文件：下次启动会重新尝试合并，用户数据不丢
        this.fail('旧文件存储迁移失败（已保留原文件，下次启动会重试）', err)
      })
  }

  list(): SourceRecord[] {
    return this.memory.list()
  }
  get(id: string): SourceRecord | undefined {
    return this.memory.get(id)
  }

  /**
   * 写一条音源：**先落盘、成功后才更新内存**。
   *
   * 顺序不能反（旧实现是先内存后落盘并且吞掉落盘错误）：内存是 `list()` 的唯一来源，
   * 一旦落盘失败而内存已更新，UI 会显示"导入成功"、当前会话也能用，重启后却什么都没有——
   * 这正是"加了音源、重启 DSH 就没了"的观感。现在落盘失败直接抛，由
   * `EngineProvider.uploadSource` 转成 `{success:false, error}` 回给 UI。
   */
  async put(record: SourceRecord): Promise<void> {
    try {
      await this.sourceTable.put(storageKey(record.id), record)
    } catch (err) {
      this.fail(`音源「${record.name}」写入 storage domain 失败（未落盘）`, err)
      throw err
    }
    await this.memory.put(record)
    await this.writeOrder()
  }

  async remove(id: string): Promise<boolean> {
    const record = this.memory.get(id)
    if (record === undefined) return false
    try {
      await this.sourceTable.delete(storageKey(id))
    } catch (err) {
      this.fail(`音源「${record.name}」删除失败（storage domain）`, err)
      throw err
    }
    await this.memory.remove(id)
    await this.writeOrder()
    return true
  }

  order(): string[] {
    return this.memory.order()
  }

  async setOrder(ids: string[]): Promise<void> {
    await this.memory.setOrder(ids)
    await this.writeOrder()
  }

  isDurable(): boolean {
    return true
  }

  kind(): 'domain' {
    return 'domain'
  }
}

/** 文件实现：直接持久化到 JSON 文件（原子写），不依赖 dsh storageDomain。
 *  用于 storage domain 打开失败或未注入时保证音源重启不丢。 */
export class FileSourceStore implements SourceStoreFace {
  private readonly file: string
  private readonly memory = new MemorySourceStore()
  private readonly onError?: SourceStoreOptions['onError']
  private writeChain: Promise<void> = Promise.resolve()

  constructor(file: string, options: SourceStoreOptions = {}) {
    this.file = file
    this.onError = options.onError
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

  /** 先落盘、成功后才更新内存（理由同 DomainSourceStore.put）。失败向上抛，不静默。 */
  async put(record: SourceRecord): Promise<void> {
    const snapshot = this.snapshotWith(record)
    await this.persist(snapshot)
    await this.memory.put(record)
  }

  async remove(id: string): Promise<boolean> {
    if (this.memory.get(id) === undefined) return false
    const ids = this.memory.list().map((r) => r.id).filter((x) => x !== id)
    const snapshot = JSON.stringify(
      { records: this.memory.list().filter((r) => r.id !== id), order: ids },
      null,
      2,
    )
    await this.persist(snapshot)
    return this.memory.remove(id)
  }

  order(): string[] {
    return this.memory.order()
  }

  async setOrder(ids: string[]): Promise<void> {
    // 顺序不影响记录集合：先在内存里算出稳定顺序，再落盘（失败只告警，与 DomainSourceStore 一致）
    await this.memory.setOrder(ids)
    try {
      await this.persist(this.snapshot())
    } catch (err) {
      this.onError?.(`音源顺序写回失败（不影响音源本身）: ${err instanceof Error ? err.message : String(err)}`, err)
    }
  }

  isDurable(): boolean {
    return true
  }

  kind(): 'file' {
    return 'file'
  }

  /** 当前内容 + 一条待写入记录（用于"先落盘后进内存"）。 */
  private snapshotWith(record: SourceRecord): string {
    const has = this.memory.get(record.id) !== undefined
    const records = has
      ? this.memory.list().map((r) => (r.id === record.id ? record : r))
      : [...this.memory.list(), record]
    const order = has ? this.memory.order() : [...this.memory.order(), record.id]
    return JSON.stringify({ records, order }, null, 2)
  }

  private snapshot(): string {
    return JSON.stringify({ records: this.memory.list(), order: this.memory.order() }, null, 2)
  }

  /**
   * 串行化原子写：tmp 文件 + rename（对齐 dsh-storage-json 的发布协议）。
   *
   * 写链自身保持"永不 reject"（否则后续写会被前一次的失败毒化），但**返回给调用方的
   * promise 会 reject** —— 这样 `put()` 能把真实的落盘失败告诉 UI，而不是让用户以为
   * 导入成功、重启后才发现音源没了。
   */
  private persist(snapshot: string): Promise<void> {
    const write = this.writeChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const tmp = join(dirname(this.file), `.${basename(this.file)}.${process.pid}.${Date.now()}.tmp`)
      await writeFile(tmp, snapshot, 'utf8')
      await rename(tmp, this.file)
    })
    this.writeChain = write.catch(() => undefined)
    return write.catch((err: unknown) => {
      this.onError?.(`音源持久化写入失败（${this.file}）: ${err instanceof Error ? err.message : String(err)}`, err)
      throw err
    })
  }
}
