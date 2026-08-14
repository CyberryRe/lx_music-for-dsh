// LLM 点歌工具：search_and_play。
// - 通过 PlaybackService 搜索、解析直链、加入播放列表（或直接播放）
// - 防刷：滑动窗口限流（rateLimitPerMinute）
// - 点歌日志：写入 storage logs 表（PlaybackService.log）

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { PlaybackService } from './playback'
import type { PlayLogEntry, PlayerState, SearchAndPlayArgs, SearchAndPlayOutput, MusicSource } from './shared/types'

export interface SearchAndPlayToolOptions {
  service: PlaybackService
  now?: () => number
}

/** 注册 search_and_play 工具到 ctx.tools。 */
export function registerSearchAndPlayTool(ctx: { tools: { register(tool: unknown): void } }, options: SearchAndPlayToolOptions): void {
  const { service } = options
  const now = options.now ?? Date.now

  ctx.tools.register(defineTool({
    name: 'search_and_play',
    description:
      '搜索并播放音乐（点歌）。输入歌曲名、歌手或模糊描述（如"来一首周杰伦的晴天"），' +
      '返回匹配歌曲列表（含音质与直链预览），并自动将选中歌曲加入播放列表；auto_play 为 true 时直接播放第一首。' +
      '适用于用户要求播放音乐、推荐背景音乐等场景。',
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: '歌曲名 / 歌手 / 模糊描述。',
      },
      limit: {
        type: 'integer',
        description: '返回结果数，默认 5。',
      },
      auto_play: {
        type: 'boolean',
        description: '是否自动播放第一首，默认 true。',
      },
      source: {
        type: 'string',
        enum: ['kw', 'wy', 'kg', 'tx', 'mg'],
        description: '指定音乐平台（可选），缺省按插件配置的平台优先级。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
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
            },
          },
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

      // 防刷：限流检查
      const limitStatus = service.rateLimiter?.tryConsume(now())
      if (limitStatus && !limitStatus.allowed) {
        throw new Error(
          `点歌过于频繁，请 ${Math.ceil(limitStatus.retryAfterMs / 1000)} 秒后再试（每分钟上限 ${service.getSettings().rateLimitPerMinute} 次）`,
        )
      }

      const limit = Math.max(1, Math.min(20, args.limit ?? 5))
      const autoPlay = args.auto_play !== false
      const sources: MusicSource[] | undefined = args.source ? [args.source] : undefined

      let playedId: string | null = null
      let error: string | undefined
      let sourceUsed: MusicSource | null = null
      try {
        // 1. 搜索（平台优先级 / 指定平台）
        const outcome = await service.search({ query, limit, sources })
        sourceUsed = outcome.usedSource
        if (outcome.results.length === 0) {
          const attemptDesc = outcome.attempts.map((a) => `${a.source}(${a.error ?? a.count})`).join(', ')
          error = `未找到与"${query}"匹配的歌曲（尝试平台：${attemptDesc}）`
          service.log(buildLog({ query, limit, autoPlay, source: null, resultsCount: 0, playedId: null, latencyMs: now() - startedAt, error }))
          throw new Error(error)
        }

        const results = outcome.results.slice(0, limit)
        // 2. 直链预览（逐首解析，失败标记空串；串行避免打爆上游）
        const previews = await Promise.all(
          results.map(async (m) => {
            try {
              const resolved = await service.resolveUrl({ music: m })
              return { id: m.id, url: resolved.url, type: resolved.type }
            } catch {
              return { id: m.id, url: null as string | null, type: null as string | null }
            }
          }),
        )
        const urlById = new Map(previews.map((p) => [p.id, p.url]))

        // 3. 加入播放列表（队尾）
        const stateAfterAdd = service.addMusic(results, 'tail')
        const first = results[0]!
        const addedIndex = stateAfterAdd.playlist.findIndex((m) => m.id === first.id)

        // 4. 自动播放第一首
        let playState: PlayerState | null = null
        if (autoPlay) {
          playState = service.play({ index: addedIndex })
          playedId = playState.current?.id ?? first.id
        }
        const playlistPosition = playState ? playState.currentIndex : addedIndex

        const output: SearchAndPlayOutput = {
          results: results.map((m) => ({
            id: m.id,
            name: m.name,
            singer: m.singer,
            source: m.source,
            interval: m.interval ?? '',
            qualitys: (m.meta.qualitys ?? []).map((q) => ({ type: q.type, size: q.size ?? '' })),
            picUrl: m.meta.picUrl ?? '',
            url: urlById.get(m.id) ?? '',
          })),
          played: autoPlay,
          playlistPosition,
          note: autoPlay ? '已开始播放第一首，播放进度可在侧边栏控制。' : '已加入播放列表（队尾），可手动播放。',
        }
        service.log(buildLog({ query, limit, autoPlay, source: sourceUsed, resultsCount: results.length, playedId, latencyMs: now() - startedAt }))
        return output
      } catch (err) {
        if (err instanceof Error && err.message.startsWith('点歌过于频繁')) throw err
        if (error) throw new Error(error, { cause: err })
        const msg = err instanceof Error ? err.message : String(err)
        service.log(buildLog({ query, limit, autoPlay, source: sourceUsed, resultsCount: 0, playedId, latencyMs: now() - startedAt, error: msg }))
        throw new Error(msg, { cause: err })
      }
    },
    presentCall: (rawArgs) => {
      const args = rawArgs as unknown as SearchAndPlayArgs
      return {
        card: 'generic',
        title: '点歌',
        kind: 'other',
        rawInput: args,
      }
    },
  }))
}

function buildLog(p: {
  query: string
  limit: number
  autoPlay: boolean
  source: MusicSource | null
  resultsCount: number
  playedId: string | null
  latencyMs: number
  error?: string
}): PlayLogEntry {
  return {
    time: new Date().toISOString(),
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
