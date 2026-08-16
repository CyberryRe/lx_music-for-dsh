// LLM 音乐工具集（细粒度）：把单一的 search_and_play 拆分为
//   music_search（搜索）/ music_play（播放）/ music_playlist（播放列表管理）/
//   music_prev / music_next（切歌）/ music_control（播放控制），
//   并保留 search_and_play 作为"一步点歌"的兼容入口。
// - 网络搜索类操作（music_search、music_play(query)、music_playlist(add)、search_and_play）
//   受滑动窗口限流保护（rateLimitPerMinute）
// - 全部操作写入点歌日志（storage logs 表，PlaybackService.log）

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { PlaybackService } from './playback'
import type {
  MusicControlArgs,
  MusicControlOutput,
  MusicInfo,
  MusicNavOutput,
  MusicPlayArgs,
  MusicPlaylistArgs,
  MusicPlaylistOutput,
  MusicPlayOutput,
  MusicSearchArgs,
  MusicSearchOutput,
  MusicSource,
  PlayLogEntry,
  PlayerState,
  SearchAndPlayArgs,
  SearchAndPlayOutput,
  SearchResultItem,
} from './shared/types'

export interface MusicToolsOptions {
  service: PlaybackService
  now?: () => number
}

const SEARCH_SOURCES = ['kw', 'wy', 'kg', 'tx', 'mg']
const QUALITIES = ['128k', '320k', 'flac', 'flac24bit', 'flac32bit', 'wav']
const PLAY_MODES = ['list', 'single', 'order', 'shuffle']

const CONTROL_LABEL: Record<string, string> = {
  toggle: '播放/暂停切换',
  pause: '已暂停',
  resume: '已继续播放',
  seek: '已跳转进度',
  volume: '已设置音量',
  quality: '已设置音质',
  playMode: '已切换播放模式',
}

// ── 共用辅助 ────────────────────────────────────────────────────────────────

function clampLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(20, Math.floor(limit ?? 5)))
}

/** 防刷：限流检查（网络搜索类操作使用）。 */
function assertRateLimit(service: PlaybackService, now: () => number): void {
  const limitStatus = service.rateLimiter?.tryConsume(now())
  if (limitStatus && !limitStatus.allowed) {
    throw new Error(
      `操作过于频繁，请 ${Math.ceil(limitStatus.retryAfterMs / 1000)} 秒后再试（每分钟上限 ${service.getSettings().rateLimitPerMinute} 次）`,
    )
  }
}

interface LogInput {
  action: string
  query: string
  limit: number
  autoPlay: boolean
  source: MusicSource | null
  resultsCount: number
  playedId: string | null
  latencyMs: number
  error?: string
}

function buildLog(p: LogInput): PlayLogEntry {
  return {
    time: new Date().toISOString(),
    action: p.action,
    query: p.query,
    limit: p.limit,
    autoPlay: p.autoPlay,
    source: p.source,
    resultsCount: p.resultsCount,
    playedId: p.playedId,
    latencyMs: p.latencyMs,
    error: p.error,
  }
}

/** 搜索（限量）并返回结果；无结果抛友好错误。 */
async function searchResults(
  service: PlaybackService,
  query: string,
  limit: number,
  source?: MusicSource,
  singer?: string,
): Promise<{ results: MusicInfo[]; sourceUsed: MusicSource | null }> {
  const outcome = await service.search({
    query,
    limit,
    sources: source ? [source] : undefined,
    singer: singer?.trim() || undefined,
  })
  if (outcome.results.length === 0) {
    const attemptDesc = outcome.attempts.map((a) => `${a.source}(${a.error ?? a.count})`).join(', ')
    throw new Error(`未找到与"${query}"匹配的歌曲（尝试平台：${attemptDesc}）`)
  }
  return { results: outcome.results.slice(0, limit), sourceUsed: outcome.usedSource }
}

/** 逐首解析直链预览（失败记为空串；串行避免打爆上游）。 */
async function previewUrls(service: PlaybackService, results: MusicInfo[]): Promise<Map<string, string>> {
  const previews = await Promise.all(
    results.map(async (m) => {
      try {
        const resolved = await service.resolveUrl({ music: m })
        return { id: m.id, url: resolved.url }
      } catch {
        return { id: m.id, url: null as string | null }
      }
    }),
  )
  return new Map(previews.map((p) => [p.id, p.url ?? '']))
}

function toResultItem(m: MusicInfo, url: string): SearchResultItem {
  return {
    id: m.id,
    name: m.name,
    singer: m.singer,
    source: m.source,
    interval: m.interval ?? '',
    qualitys: (m.meta.qualitys ?? []).map((q) => ({ type: q.type, size: q.size ?? '' })),
    picUrl: m.meta.picUrl ?? '',
    url,
  }
}

/** 播放状态摘要（工具输出共用）。 */
function summarize(state: PlayerState): MusicNavOutput {
  return {
    played: state.currentIndex >= 0 && state.status === 'playing',
    playlistPosition: state.currentIndex,
    current: state.current ? { name: state.current.name, singer: state.current.singer, source: state.current.source } : null,
    status: state.status,
    playlistCount: state.playlist.length,
  }
}

function listSummary(state: PlayerState): MusicPlaylistOutput['playlist'] {
  return state.playlist.map((m, i) => ({ index: i, id: m.id, name: m.name, singer: m.singer, source: m.source, interval: m.interval ?? '' }))
}

function renderText(...lines: Array<string | undefined>): Array<{ type: 'text'; text: string }> {
  return [{ type: 'text', text: lines.filter((l): l is string => Boolean(l)).join('\n') }]
}

// ── 输出 schema（defineTool 输出 DSL：additionalProperties 必须显式声明） ───
// 用 satisfies 校验 schema 形状，同时保留字面量类型供 defineTool 推断输出值类型。

const RESULT_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    singer: { type: 'string', required: true },
    source: { type: 'string', required: true },
    interval: { type: 'string', required: true },
    qualitys: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          type: { type: 'string', required: true },
          size: { type: 'string', required: true },
        },
      },
    },
    picUrl: { type: 'string', required: true },
    url: { type: 'string', required: true },
  },
} satisfies ValueSchemaSpec

const CURRENT_SCHEMA = {
  oneOf: [
    { type: 'null' },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', required: true },
        singer: { type: 'string', required: true },
        source: { type: 'string', required: true },
      },
    },
  ],
} satisfies ValueSchemaSpec

const SUMMARY_SCHEMA = {
  played: { type: 'boolean', required: true },
  playlistPosition: { type: 'integer', required: true },
  current: CURRENT_SCHEMA,
  status: { type: 'string', required: true },
  playlistCount: { type: 'integer', required: true },
} satisfies ParameterSchemaSpec

const PLAYLIST_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    index: { type: 'integer', required: true },
    id: { type: 'string', required: true },
    name: { type: 'string', required: true },
    singer: { type: 'string', required: true },
    source: { type: 'string', required: true },
    interval: { type: 'string', required: true },
  },
} satisfies ValueSchemaSpec

// ── 工具：music_search（搜索） ──────────────────────────────────────────────

function buildSearchTool(service: PlaybackService, now: () => number): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'music_search',
    description:
      '搜索音乐（仅搜索，不自动播放）。输入歌曲名、歌手或模糊描述，返回匹配歌曲列表（含平台、时长、音质）；' +
      'with_url=true 时额外解析直链预览（较慢）。需要播放时请调用 music_play。',
    parameters: {
      query: { type: 'string', required: true, description: '歌曲名 / 歌手 / 模糊描述。' },
      limit: { type: 'integer', description: '返回结果数，默认 5（1-20）。' },
      source: { type: 'string', enum: SEARCH_SOURCES, description: '指定音乐平台（可选），缺省按配置的平台优先级。' },
      singer: { type: 'string', description: '歌手过滤（可选）。' },
      with_url: { type: 'boolean', description: '是否解析直链预览，默认 false。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', required: true, items: RESULT_ITEM_SCHEMA },
          usedSource: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: MusicSearchOutput) => {
        const lines = value.results.map((r, i) => {
          const q = (r.qualitys ?? []).map((x) => x.type).join('/') || '未知音质'
          const urlHint = r.url ? '（直链已就绪）' : ''
          return `${i + 1}. ${r.name} - ${r.singer} [${r.source}] ${r.interval ?? ''} ${q}${urlHint}`
        })
        return renderText(`搜索到 ${value.results.length} 首歌曲：`, ...lines, value.note)
      },
    },
    execute: async (rawArgs) => {
      const args = rawArgs as unknown as MusicSearchArgs
      const startedAt = now()
      const query = (args.query ?? '').trim()
      if (!query) throw new Error('query 不能为空')
      assertRateLimit(service, now)
      const limit = clampLimit(args.limit)
      let sourceUsed: MusicSource | null = null
      try {
        const outcome = await service.search({
          query,
          limit,
          sources: args.source ? [args.source] : undefined,
          singer: args.singer?.trim() || undefined,
        })
        sourceUsed = outcome.usedSource
        if (outcome.results.length === 0) {
          const attemptDesc = outcome.attempts.map((a) => `${a.source}(${a.error ?? a.count})`).join(', ')
          throw new Error(`未找到与"${query}"匹配的歌曲（尝试平台：${attemptDesc}）`)
        }
        const results = outcome.results.slice(0, limit)
        const urls = args.with_url ? await previewUrls(service, results) : new Map<string, string>()
        const output: MusicSearchOutput = {
          results: results.map((m) => toResultItem(m, urls.get(m.id) ?? '')),
          usedSource: sourceUsed ?? '',
          note: args.with_url ? '已解析直链预览，可直接播放。' : '未解析直链；需要播放时调用 music_play（会按需解析直链）。',
        }
        service.log(buildLog({ action: 'search', query, limit, autoPlay: false, source: sourceUsed, resultsCount: results.length, playedId: null, latencyMs: now() - startedAt }))
        return output
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('操作过于频繁')) throw err
        const msg = err instanceof Error ? err.message : String(err)
        service.log(buildLog({ action: 'search', query, limit, autoPlay: false, source: sourceUsed, resultsCount: 0, playedId: null, latencyMs: now() - startedAt, error: msg }))
        throw new Error(msg, { cause: err })
      }
    },
    presentCall: (rawArgs) => {
      const args = rawArgs as unknown as MusicSearchArgs
      return { card: 'generic', title: '搜索音乐', kind: 'other', rawInput: { query: args.query } }
    },
  })
}

// ── 工具：music_play（播放） ────────────────────────────────────────────────

function buildPlayTool(service: PlaybackService, now: () => number): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'music_play',
    description:
      '播放音乐。两种用法：1) query：搜索并播放匹配歌曲（result_index 选择第几首，默认第一首；auto_play=false 时仅加入播放列表）；' +
      '2) index：直接播放播放列表中第 index 首（从 0 开始）。播放前会自动解析直链。',
    parameters: {
      query: { type: 'string', description: '搜索关键词（与 index 二选一）。' },
      index: { type: 'integer', description: '播放列表序号（从 0 开始，与 query 二选一）。' },
      result_index: { type: 'integer', description: 'query 搜索结果的第几首（从 0 开始），默认 0。' },
      source: { type: 'string', enum: SEARCH_SOURCES, description: '指定搜索平台（可选）。' },
      auto_play: { type: 'boolean', description: '是否立即播放，默认 true；false 时仅加入播放列表。' },
      position: { type: 'string', enum: ['tail', 'next'], description: '加入播放列表的位置：tail=队尾（默认）/ next=当前曲目之后。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { ...SUMMARY_SCHEMA, note: { type: 'string', required: true } },
      },
      render: (_args, value: MusicPlayOutput) => {
        const cur = value.current ? `${value.current.name} - ${value.current.singer}` : '无'
        return renderText(
          value.played ? `正在播放：${cur}（播放列表第 ${value.playlistPosition + 1} 首，共 ${value.playlistCount} 首）` : `当前：${cur}（共 ${value.playlistCount} 首）`,
          value.note,
        )
      },
    },
    execute: async (rawArgs) => {
      const args = rawArgs as unknown as MusicPlayArgs
      const startedAt = now()
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      const hasIndex = typeof args.index === 'number' && Number.isInteger(args.index) && args.index >= 0

      // 用法 2：播放列表序号直接播放（不涉及网络搜索，不限流）
      if (hasIndex) {
        try {
          const st = service.play({ index: args.index })
          const out: MusicPlayOutput = {
            ...summarize(st),
            note: `已播放播放列表第 ${args.index! + 1} 首。`,
          }
          service.log(buildLog({ action: 'play', query: '', limit: 0, autoPlay: true, source: null, resultsCount: 0, playedId: st.current?.id ?? null, latencyMs: now() - startedAt }))
          return out
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          service.log(buildLog({ action: 'play', query: '', limit: 0, autoPlay: true, source: null, resultsCount: 0, playedId: null, latencyMs: now() - startedAt, error: msg }))
          throw new Error(msg, { cause: err })
        }
      }

      // 用法 1：搜索并播放
      if (!query) throw new Error('需要提供 query（搜索播放）或 index（播放列表序号）')
      assertRateLimit(service, now)
      const want = Math.max(0, Math.floor(args.result_index ?? 0))
      let sourceUsed: MusicSource | null = null
      try {
        const { results, sourceUsed: used } = await searchResults(service, query, want + 1, args.source)
        sourceUsed = used
        const target = results[want]
        if (!target) throw new Error(`搜索结果中没有第 ${want + 1} 首`)
        // 解析直链：失败则报错（无法播放坏曲目）
        await service.resolveUrl({ music: target })
        const position = args.position ?? 'tail'
        const st = service.addMusic([target], position)
        let finalState: PlayerState = st
        const autoPlay = args.auto_play !== false
        if (autoPlay) {
          const idx = st.playlist.findIndex((m) => m.id === target.id)
          finalState = service.play({ index: idx })
        }
        const out: MusicPlayOutput = {
          ...summarize(finalState),
          note: autoPlay
            ? `已开始播放「${target.name} - ${target.singer}」（${position === 'next' ? '下一首位置' : '队尾'}加入，列表第 ${finalState.playlist.findIndex((m) => m.id === target.id) + 1} 首）。`
            : `已将「${target.name} - ${target.singer}」加入播放列表（${position === 'next' ? '下一首位置' : '队尾'}）。`,
        }
        service.log(buildLog({ action: 'play', query, limit: want + 1, autoPlay, source: sourceUsed, resultsCount: 1, playedId: target.id, latencyMs: now() - startedAt }))
        return out
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('操作过于频繁')) throw err
        const msg = err instanceof Error ? err.message : String(err)
        service.log(buildLog({ action: 'play', query, limit: want + 1, autoPlay: args.auto_play !== false, source: sourceUsed, resultsCount: 0, playedId: null, latencyMs: now() - startedAt, error: msg }))
        throw new Error(msg, { cause: err })
      }
    },
    presentCall: (rawArgs) => {
      const args = rawArgs as unknown as MusicPlayArgs
      return { card: 'generic', title: '播放音乐', kind: 'other', rawInput: { query: args.query, index: args.index } }
    },
  })
}

// ── 工具：music_playlist（播放列表管理） ────────────────────────────────────

function buildPlaylistTool(service: PlaybackService, now: () => number): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'music_playlist',
    description:
      '播放列表管理：list=查看播放列表；add=搜索并加入播放列表（需要 query）；remove=按序号 index 或 id 移除；' +
      'clear=清空列表；export=导出为文本。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['list', 'add', 'remove', 'clear', 'export'],
        description: '操作类型：list/add/remove/clear/export。',
      },
      query: { type: 'string', description: 'add：搜索关键词。' },
      limit: { type: 'integer', description: 'add：加入数量，默认 5（1-20）。' },
      source: { type: 'string', enum: SEARCH_SOURCES, description: 'add：指定搜索平台（可选）。' },
      position: { type: 'string', enum: ['tail', 'next'], description: 'add：加入位置 tail（队尾，默认）/ next（当前曲目之后）。' },
      index: { type: 'integer', description: 'remove：序号（从 0 开始，与 id 二选一）。' },
      id: { type: 'string', description: 'remove：歌曲 id（与 index 二选一）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          currentIndex: { type: 'integer', required: true },
          playlist: { type: 'array', required: true, items: PLAYLIST_ITEM_SCHEMA },
          text: { type: 'string' },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: MusicPlaylistOutput) => {
        const head = `播放列表（${value.count} 首，当前第 ${value.currentIndex + 1} 首）：${value.note}`
        const lines = value.playlist.map((m) => `${m.index === value.currentIndex ? '▶' : ' '} ${m.index + 1}. ${m.name} - ${m.singer} [${m.source}] ${m.interval ?? ''}`)
        return renderText(head, ...lines, value.text)
      },
    },
    execute: async (rawArgs) => {
      const args = rawArgs as unknown as MusicPlaylistArgs
      const startedAt = now()
      const action = args.action
      if (!action || !['list', 'add', 'remove', 'clear', 'export'].includes(action)) {
        throw new Error(`未知操作: ${String(action)}`)
      }
      let st: PlayerState | null = null
      let text: string | undefined
      let note = ''
      let logError: string | undefined

      try {
        switch (action) {
          case 'list': {
            st = service.getState()
            note = `共 ${st.playlist.length} 首。`
            break
          }
          case 'add': {
            const query = (args.query ?? '').trim()
            if (!query) throw new Error('add 操作需要提供 query（搜索关键词）')
            assertRateLimit(service, now)
            const limit = clampLimit(args.limit)
            const { results, sourceUsed } = await searchResults(service, query, limit, args.source)
            const position = args.position ?? 'tail'
            st = service.addMusic(results, position)
            note = `已将 ${results.length} 首歌曲加入播放列表（${position === 'next' ? '当前曲目之后' : '队尾'}），当前共 ${st.playlist.length} 首。`
            service.log(buildLog({ action: 'playlist.add', query, limit, autoPlay: false, source: sourceUsed, resultsCount: results.length, playedId: null, latencyMs: now() - startedAt }))
            break
          }
          case 'remove': {
            let id: string | undefined = args.id
            if (!id && typeof args.index === 'number' && Number.isInteger(args.index) && args.index >= 0) {
              const m = service.getState().playlist[args.index]
              if (!m) throw new Error(`播放列表没有第 ${args.index + 1} 首`)
              id = m.id
            }
            if (!id) throw new Error('remove 操作需要提供 id 或 index')
            st = service.removeMusic(id)
            note = `已移除该歌曲，剩余 ${st.playlist.length} 首。`
            break
          }
          case 'clear': {
            st = service.clearList()
            note = '播放列表已清空。'
            break
          }
          case 'export': {
            text = service.exportList()
            st = service.getState()
            note = '播放列表文本见 text 字段。'
            break
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('操作过于频繁')) throw err
        logError = err instanceof Error ? err.message : String(err)
        service.log(buildLog({ action: `playlist.${action}`, query: args.query ?? '', limit: clampLimit(args.limit), autoPlay: false, source: null, resultsCount: 0, playedId: null, latencyMs: now() - startedAt, error: logError }))
        throw new Error(logError, { cause: err })
      }

      st = st ?? service.getState()
      const out: MusicPlaylistOutput = {
        action,
        count: st.playlist.length,
        currentIndex: st.currentIndex,
        playlist: listSummary(st),
        ...(text !== undefined ? { text } : {}),
        note,
      }
      if (action !== 'add' && action !== 'list') {
        service.log(buildLog({ action: `playlist.${action}`, query: '', limit: 0, autoPlay: false, source: null, resultsCount: 0, playedId: null, latencyMs: now() - startedAt, error: logError }))
      }
      return out
    },
    presentCall: (rawArgs) => {
      const args = rawArgs as unknown as MusicPlaylistArgs
      return { card: 'generic', title: '播放列表', kind: 'other', rawInput: args }
    },
  })
}

// ── 工具：music_prev / music_next（切歌） ───────────────────────────────────

function buildNavTool(service: PlaybackService, now: () => number, direction: 'next' | 'prev'): ReturnType<typeof defineTool> {
  const isNext = direction === 'next'
  return defineTool({
    name: isNext ? 'music_next' : 'music_prev',
    description: isNext
      ? '播放下一首。按当前播放模式：列表循环/单曲循环时循环下一首，随机播放时随机选曲，顺序播放到末尾则停止。'
      : '播放上一首。顺序播放到列表开头时重播第一首，其余模式循环回退。',
    parameters: {},
    output: {
      schema: { type: 'object', additionalProperties: false, properties: SUMMARY_SCHEMA },
      render: (_args, value: MusicNavOutput) => {
        const cur = value.current ? `${value.current.name} - ${value.current.singer}` : '无'
        return renderText(
          value.played
            ? `正在播放：${cur}（播放列表第 ${value.playlistPosition + 1} 首，共 ${value.playlistCount} 首）`
            : `当前：${cur}（共 ${value.playlistCount} 首，状态 ${value.status}）`,
        )
      },
    },
    execute: async () => {
      const startedAt = now()
      let st: PlayerState
      try {
        st = service[direction]()
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        service.log(buildLog({ action: direction, query: '', limit: 0, autoPlay: true, source: null, resultsCount: 0, playedId: null, latencyMs: now() - startedAt, error: msg }))
        throw new Error(msg, { cause: err })
      }
      service.log(buildLog({ action: direction, query: '', limit: 0, autoPlay: true, source: null, resultsCount: 0, playedId: st.current?.id ?? null, latencyMs: now() - startedAt }))
      return summarize(st)
    },
    presentCall: () => ({ card: 'generic', title: isNext ? '下一首' : '上一首', kind: 'other', rawInput: {} }),
  })
}

// ── 工具：music_control（播放控制） ─────────────────────────────────────────

function buildControlTool(service: PlaybackService, now: () => number): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'music_control',
    description:
      '播放控制：toggle=播放/暂停切换，pause=暂停，resume=继续播放，seek=跳转进度（seconds，秒），' +
      'volume=音量（0-1），quality=音质（128k/320k/flac/flac24bit/flac32bit/wav），' +
      'playMode=播放模式（list=列表循环 / single=单曲循环 / order=顺序播放 / shuffle=随机播放）。',
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['toggle', 'pause', 'resume', 'seek', 'volume', 'quality', 'playMode'],
        description: '控制操作。',
      },
      seconds: { type: 'number', description: 'seek：目标进度（秒）。' },
      volume: { type: 'number', description: 'volume：音量 0-1。' },
      quality: { type: 'string', enum: QUALITIES, description: 'quality：目标音质。' },
      play_mode: { type: 'string', enum: PLAY_MODES, description: 'playMode：列表循环/单曲循环/顺序播放/随机播放。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ...SUMMARY_SCHEMA,
          action: { type: 'string', required: true },
          volume: { type: 'number', required: true },
          quality: { type: 'string', required: true },
          playMode: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: MusicControlOutput) => {
        const cur = value.current ? `${value.current.name} - ${value.current.singer}` : '无'
        return renderText(
          `[${value.action}] 当前：${cur}（状态 ${value.status}，音量 ${Math.round(value.volume * 100)}%，音质 ${value.quality}，播放模式 ${value.playMode}）`,
          value.note,
        )
      },
    },
    execute: async (rawArgs) => {
      const args = rawArgs as unknown as MusicControlArgs
      const startedAt = now()
      const action = args.action
      let st: PlayerState
      try {
        switch (action) {
          case 'toggle':
            st = service.toggle()
            break
          case 'pause':
            st = service.pause()
            break
          case 'resume': {
            const cur = service.getState()
            if (cur.playlist.length === 0) throw new Error('播放列表为空')
            if (cur.status === 'playing') {
              st = cur
            } else if (cur.status === 'paused' && cur.currentIndex >= 0) {
              st = service.toggle()
            } else {
              st = service.play({ index: Math.max(0, cur.currentIndex) })
            }
            break
          }
          case 'seek': {
            if (typeof args.seconds !== 'number' || !Number.isFinite(args.seconds) || args.seconds < 0) {
              throw new Error('seek 需要非负 seconds 参数')
            }
            service.seek(args.seconds)
            st = service.getState()
            break
          }
          case 'volume': {
            if (typeof args.volume !== 'number' || !Number.isFinite(args.volume) || args.volume < 0 || args.volume > 1) {
              throw new Error('volume 需要 0-1 之间的数字')
            }
            st = service.setVolume(args.volume)
            break
          }
          case 'quality': {
            if (!args.quality) throw new Error('quality 操作需要提供 quality 参数')
            st = service.setQuality(args.quality)
            break
          }
          case 'playMode': {
            if (!args.play_mode) throw new Error('playMode 操作需要提供 play_mode 参数')
            st = service.setPlayMode(args.play_mode)
            break
          }
          default:
            throw new Error(`未知控制操作: ${String(action)}`)
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        service.log(buildLog({ action: `control.${String(action)}`, query: '', limit: 0, autoPlay: false, source: null, resultsCount: 0, playedId: null, latencyMs: now() - startedAt, error: msg }))
        throw new Error(msg, { cause: err })
      }
      const out: MusicControlOutput = {
        ...summarize(st),
        action,
        volume: st.volume,
        quality: st.quality,
        playMode: st.playMode,
        note: CONTROL_LABEL[action] ?? '操作完成。',
      }
      service.log(buildLog({ action: `control.${action}`, query: '', limit: 0, autoPlay: false, source: null, resultsCount: 0, playedId: null, latencyMs: now() - startedAt }))
      return out
    },
    presentCall: (rawArgs) => {
      const args = rawArgs as unknown as MusicControlArgs
      return { card: 'generic', title: '播放控制', kind: 'other', rawInput: { action: args.action } }
    },
  })
}

// ── 兼容工具：search_and_play（一步点歌，行为与旧版一致） ───────────────────

function buildLegacyTool(service: PlaybackService, now: () => number): ReturnType<typeof defineTool> {
  return defineTool({
    name: 'search_and_play',
    description:
      '（兼容入口，建议优先使用 music_play / music_search）搜索并播放音乐（点歌）。输入歌曲名、歌手或模糊描述' +
      '（如"来一首周杰伦的晴天"），返回匹配歌曲列表（含音质与直链预览），并自动将选中歌曲加入播放列表；' +
      'auto_play 为 true 时直接播放第一首。',
    parameters: {
      query: { type: 'string', required: true, description: '歌曲名 / 歌手 / 模糊描述。' },
      limit: { type: 'integer', description: '返回结果数，默认 5。' },
      auto_play: { type: 'boolean', description: '是否自动播放第一首，默认 true。' },
      source: { type: 'string', enum: SEARCH_SOURCES, description: '指定音乐平台（可选），缺省按插件配置的平台优先级。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: { type: 'array', required: true, items: RESULT_ITEM_SCHEMA },
          played: { type: 'boolean', required: true },
          playlistPosition: { type: 'integer', required: true },
          note: { type: 'string' },
        },
      },
      render: (_args, value: SearchAndPlayOutput) => {
        const lines = value.results.map((r, i) => {
          const q = (r.qualitys ?? []).map((x) => x.type).join('/') || '未知音质'
          const urlHint = r.url ? '（直链已就绪）' : ''
          return `${i + 1}. ${r.name} - ${r.singer} [${r.source}] ${r.interval ?? ''} ${q}${urlHint}`
        })
        const head = value.played
          ? `已开始播放：${value.results[0]?.name ?? ''} - ${value.results[0]?.singer ?? ''}（播放列表第 ${value.playlistPosition + 1} 首）`
          : `已将 ${value.results.length} 首歌曲加入播放列表。`
        return [{ type: 'text', text: `${head}\n${lines.join('\n')}` }]
      },
    },
    execute: async (rawArgs) => {
      const args = rawArgs as unknown as SearchAndPlayArgs
      const startedAt = now()
      const query = (args.query ?? '').trim()
      if (!query) throw new Error('query 不能为空')
      assertRateLimit(service, now)
      const limit = clampLimit(args.limit)
      const autoPlay = args.auto_play !== false
      let playedId: string | null = null
      let sourceUsed: MusicSource | null = null
      try {
        const { results, sourceUsed: used } = await searchResults(service, query, limit, args.source)
        sourceUsed = used
        // 直链预览（逐首解析，失败标记空串；串行避免打爆上游）
        const urls = await previewUrls(service, results)
        // 加入播放列表（队尾）
        const stateAfterAdd = service.addMusic(results, 'tail')
        const first = results[0]!
        const addedIndex = stateAfterAdd.playlist.findIndex((m) => m.id === first.id)
        // 自动播放第一首
        let playState: PlayerState | null = null
        if (autoPlay) {
          playState = service.play({ index: addedIndex })
          playedId = playState.current?.id ?? first.id
        }
        const playlistPosition = playState ? playState.currentIndex : addedIndex
        const output: SearchAndPlayOutput = {
          results: results.map((m) => toResultItem(m, urls.get(m.id) ?? '')),
          played: autoPlay,
          playlistPosition,
          note: autoPlay ? '已开始播放第一首，播放进度可在侧边栏控制。' : '已加入播放列表（队尾），可手动播放。',
        }
        service.log(buildLog({ action: 'search_and_play', query, limit, autoPlay, source: sourceUsed, resultsCount: results.length, playedId, latencyMs: now() - startedAt }))
        return output
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('操作过于频繁')) throw err
        const msg = err instanceof Error ? err.message : String(err)
        service.log(buildLog({ action: 'search_and_play', query, limit, autoPlay, source: sourceUsed, resultsCount: 0, playedId, latencyMs: now() - startedAt, error: msg }))
        throw new Error(msg, { cause: err })
      }
    },
    presentCall: (rawArgs) => {
      const args = rawArgs as unknown as SearchAndPlayArgs
      return { card: 'generic', title: '点歌', kind: 'other', rawInput: args }
    },
  })
}

// ── 注册入口 ────────────────────────────────────────────────────────────────

/** 注册细粒度音乐工具集（music_* 6 个 + 兼容 search_and_play）。 */
export function registerMusicTools(ctx: { tools: { register(tool: unknown): void } }, options: MusicToolsOptions): void {
  const { service } = options
  const now = options.now ?? Date.now
  ctx.tools.register(buildSearchTool(service, now))
  ctx.tools.register(buildPlayTool(service, now))
  ctx.tools.register(buildPlaylistTool(service, now))
  ctx.tools.register(buildNavTool(service, now, 'prev'))
  ctx.tools.register(buildNavTool(service, now, 'next'))
  ctx.tools.register(buildControlTool(service, now))
  ctx.tools.register(buildLegacyTool(service, now))
}

/**
 * 旧版入口（兼容）：仅注册 search_and_play。
 * @deprecated 请使用 registerMusicTools 注册完整工具集。
 */
export function registerSearchAndPlayTool(ctx: { tools: { register(tool: unknown): void } }, options: MusicToolsOptions): void {
  const { service } = options
  const now = options.now ?? Date.now
  ctx.tools.register(buildLegacyTool(service, now))
}
