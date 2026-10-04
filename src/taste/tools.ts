// 画像工具集（LLM 面）：music_profile（读画像）/ music_play_song（精确点播）/ music_taste（读写口味）。
//
// 三条贯穿这里的设计原则（docs/design-taste-memory.md §3、§7、§8、§10）：
//   1. **搜索从"决策者"降级为"身份翻译器"**：music_play_song 优先用画像里已确认的
//      {source,id} 直取（零搜索）；退化到按曲名+艺人精确确认时，严格校验不通过就**明确失败**，
//      绝不"取搜索结果第 0 个"（那正是把《晴天》放成 RyaVocal 翻唱的原因）。
//   2. **输出有硬上限**：结果 ≤ 8 条候选、理由 ≤ 12 字，避免把 token 花在信息搬运上。
//   3. **指令放 skill 正文，工具描述保持静态**：这里不注入任何动态内容（会破坏 prompt 缓存）。

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MusicInfo, PlayLogEntry, Quality } from '../shared/types'
import { MUSIC_SOURCES } from '../shared/types'
import type { PlaybackService } from '../playback'
import { explicitDelta } from './events'
import { EXPLORE_COOLDOWN_DAYS, EXPLORE_MAX_CANDIDATES, EXPLORE_MAX_SEEDS, rankUnheardCandidates } from './explore'
import { normalizeArtist, pickBestMatch, secondsFromInterval, trackKey as makeKey, type VariantKind } from './normalize'
import { runWithPlayContext } from './origin'
import type { TasteStore } from './store'
import type { MemoryConfig } from './config'
import type { StoredTrack } from './schema'

export interface TasteToolsOptions {
  service: PlaybackService
  store: TasteStore
  memory: MemoryConfig
  now?: () => number
  /** 点歌日志出口（index.ts 写进 storage 的 logs 表；画像未开启时上游会门控掉）。 */
  onLog?: (entry: PlayLogEntry) => void
}

/** 预算档位 → 候选数与理由详细度（§10）。 */
const BUDGET_PROFILE = {
  off: { candidates: 0, reasons: false },
  minimal: { candidates: 3, reasons: false },
  balanced: { candidates: 5, reasons: true },
  rich: { candidates: 8, reasons: true },
} as const

const REASON_MAX = 12
const VARIANTS = ['original', 'live', 'cover', 'instrumental', 'remix', 'unknown']

function trimReason(text: string, enabled: boolean): string {
  if (!enabled) return ''
  return text.length > REASON_MAX ? `${text.slice(0, REASON_MAX - 1)}…` : text
}

// ── music_profile ───────────────────────────────────────────────────────────

const PROFILE_TRACK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    title: { type: 'string', required: true },
    artist: { type: 'string', required: true },
    source: { type: 'string', required: true },
    id: { type: 'string', required: true },
    score: { type: 'number', required: true },
    status: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const

const PROFILE_ARTIST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    score: { type: 'number', required: true },
    plays: { type: 'integer', required: true },
    skips: { type: 'integer', required: true },
    confidence: { type: 'string', required: true },
    reason: { type: 'string', required: true },
  },
} as const

interface ProfileArgs {
  view?: string
  mood?: string
  limit?: number
}

function buildProfileTool(options: TasteToolsOptions): ReturnType<typeof defineTool> {
  const { store, memory } = options
  const now = options.now ?? Date.now
  const budget = BUDGET_PROFILE[memory.budget]
  return defineTool({
    name: 'music_profile',
    description:
      '查看用户的音乐口味画像（本地统计，不含原始播放记录）。' +
      '主动为当前情境点歌前先调用它拿候选，再用 music_play_song 精确播放。' +
      'view：digest=摘要 / artists=常听艺人 / tracks=可直取的曲目 / for-mood=某个情绪下的偏好 /' +
      'explore-brief=推荐"没听过但在口味范围内"的歌（返回确定候选，挑一首用 music_play_song 的 mode=explore 播放）。',
    parameters: {
      view: {
        type: 'string',
        enum: ['digest', 'artists', 'tracks', 'for-mood', 'explore-brief'],
        required: true,
        description: '要看的视图。explore-brief=为"推荐没听过的歌"给出种子与候选。',
      },
      mood: { type: 'string', description: 'for-mood 用：情境关键词（frustrated/stuck/happy/focused 或自由文本）。' },
      limit: { type: 'integer', description: '候选数上限（受预算档位限制）。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          view: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          artists: { type: 'array', required: true, items: PROFILE_ARTIST_SCHEMA },
          tracks: { type: 'array', required: true, items: PROFILE_TRACK_SCHEMA },
          sampleSize: { type: 'integer', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: { summary: string; artists: Array<{ name: string; reason: string }>; tracks: Array<{ title: string; artist: string; reason: string }>; note: string }) => {
        const lines: string[] = [value.summary]
        for (const a of value.artists) lines.push(`- ${a.name}${a.reason ? `（${a.reason}）` : ''}`)
        for (const t of value.tracks) lines.push(`♪ ${t.title} - ${t.artist}${t.reason ? `（${t.reason}）` : ''}`)
        if (value.note) lines.push(value.note)
        return lines.map((text) => ({ type: 'text' as const, text }))
      },
    },
    execute: async (rawArgs) => {
      const args = rawArgs as unknown as ProfileArgs
      const ts = now()
      if (!memory.enabled) {
        return {
          view: args.view ?? 'digest',
          summary: '音乐画像已关闭（用户可在设置页「我的口味」里开启）。',
          artists: [],
          tracks: [],
          sampleSize: 0,
          note: '画像关闭时不会记录也不会读取任何收听数据；请直接询问用户偏好，或用 music_search 找歌。',
        }
      }
      const limit = Math.max(1, Math.min(budget.candidates || 5, Math.floor(args.limit ?? (budget.candidates || 5))))
      const artists = store.top('artist', { now: ts, halfLifeDays: memory.halfLifeDays, limit })
      const tracks = store.top('track', { now: ts, halfLifeDays: memory.halfLifeDays, limit })
      const state = store.readState()
      const mood = args.mood?.trim()

      // ── explore-brief：推荐"没听过但在口味范围内"的歌 ─────────────────────
      // 候选来源①「同艺人未听曲目」：按常听艺人的名字搜索，天然落在喜好范围内，不需要标签。
      // 置信度门控用 proactive（medium+）：样本太少的艺人不足以代表口味，不该拿来探索。
      if (args.view === 'explore-brief') {
        const seeds = store.top('artist', { now: ts, halfLifeDays: memory.halfLifeDays, limit: EXPLORE_MAX_SEEDS, minPurpose: 'proactive' })
        if (seeds.length === 0) {
          return {
            view: 'explore-brief',
            summary: '还没有足够的数据做探索（需要某位艺人至少 5 次收听证据）。先多听几首，或直接问用户想听什么。',
            artists: [],
            tracks: [],
            sampleSize: 0,
            note: '探索是"推荐没听过的歌"，样本不足时容易推偏；此时改用 music_play_song({title,artist}) 播用户点名的歌更稳。',
          }
        }
        const resultsBySeed = new Map<string, Array<{ name: string; singer: string; source: string; id: string; albumName?: string; interval?: string }>>()
        await Promise.all(
          seeds.map(async (seed) => {
            try {
              const outcome = await options.service.search({ query: seed.raw ?? seed.key, limit: 10 })
              resultsBySeed.set(
                seed.key,
                outcome.results.map((m) => ({
                  name: m.name,
                  singer: m.singer,
                  source: m.source,
                  id: m.id,
                  ...(m.meta?.albumName ? { albumName: m.meta.albumName } : {}),
                  ...(m.interval ? { interval: m.interval } : {}),
                })),
              )
            } catch {
              // 单个种子搜索失败不影响其它种子
            }
          }),
        )
        const candidates = rankUnheardCandidates({
          seeds: seeds.map((s) => ({ key: s.key, raw: s.raw ?? s.key, score: s.score, confidence: s.confidence })),
          resultsBySeed,
          playedKeys: store.playedKeys(),
          recentlyExplored: store.recentlyExplored(ts, EXPLORE_COOLDOWN_DAYS),
          limit: Math.max(1, Math.min(EXPLORE_MAX_CANDIDATES, limit)),
        })
        return {
          view: 'explore-brief',
          summary:
            candidates.length > 0
              ? `探索建议：从常听的 ${seeds.map((s) => s.raw ?? s.key).join('、')} 里挑了 ${candidates.length} 首你还没听过的。`
              : `常听的 ${seeds.map((s) => s.raw ?? s.key).join('、')} 暂时没有可探索的新曲目（都听过或在冷却期内）。`,
          artists: seeds.map((s) => ({
            name: s.raw ?? s.key,
            score: s.score,
            plays: s.plays,
            skips: s.skips,
            confidence: s.confidence,
            reason: trimReason(`${s.plays} 次播放`, budget.reasons),
          })),
          tracks: candidates.map((c) => ({
            title: c.title,
            artist: c.artist,
            source: c.source,
            id: c.id,
            score: c.score,
            status: 'unheard',
            reason: trimReason(c.reason, budget.reasons),
          })),
          sampleSize: seeds.reduce((sum, s) => sum + s.plays + s.skips, 0),
          note:
            candidates.length > 0
              ? '这些是**没听过**的同艺人曲目。挑一首最契合当前情境的，用 music_play_song({title,artist,mode:"explore"}) 播放——探索模式下若被切走，对艺人的负反馈会大幅打折。'
              : '没有可探索的新曲目时，不要硬凑：可以换成复听，或问用户想听什么。',
        }
      }

      const artistRows = artists.map((a) => ({
        name: a.raw ?? a.key,
        score: a.score,
        plays: a.plays,
        skips: a.skips,
        confidence: a.confidence,
        reason: trimReason(`${a.plays} 次播放${a.skips ? ` / ${a.skips} 次跳过` : ''}`, budget.reasons),
      }))

      const trackRows: Array<{ title: string; artist: string; source: string; id: string; score: number; status: string; reason: string }> = []
      for (const t of tracks) {
        const record = t as unknown as StoredTrack
        const ref = store.trackRef(t.key)
        if (!ref) continue // 没有可直取引用就不给候选（避免又退化成搜索）
        trackRows.push({
          title: record.title ?? t.key.split('|')[0] ?? '',
          artist: record.artist ?? t.key.split('|')[1] ?? '',
          source: ref.source,
          id: ref.music.id,
          score: t.score,
          status: record.status ?? 'played',
          reason: trimReason(record.status === 'played' ? `${t.plays} 次播放` : '只确认过没听过', budget.reasons),
        })
      }

      // for-mood：优先用"情绪×艺人"关联，其次退回常听艺人
      let moodSummary = ''
      if (args.view === 'for-mood' && mood) {
        const tagTable = store.load('tag')
        const prefix = `mood:${mood}@artist:`
        const matched = Object.keys(tagTable)
          .filter((key) => key.startsWith(prefix))
          .map((key) => ({ key: key.slice(prefix.length), score: tagTable[key]?.implicit ?? 0 }))
          .filter((x) => x.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
        moodSummary = matched.length
          ? `情境「${mood}」下常听：${matched.map((m) => m.key).join('、')}。`
          : `还没有「${mood}」情境下的历史；以下按总体口味给出候选。`
      }

      const sampleSize = state.exploreStats ? state.exploreStats.replayPlays + state.exploreStats.explorePlays : artists.reduce((sum, a) => sum + a.plays, 0)
      const summary = moodSummary
        ? `${moodSummary}（样本 ${sampleSize} 次播放）`
        : artists.length > 0
          ? `近 ${memory.halfLifeDays} 天常听：${artistRows.map((a) => a.name).join('、')}（样本 ${sampleSize} 次播放）。`
          : '还没有足够的收听记录，暂时没有画像；可以先播放几首，或用 music_taste 显式告诉画像。'

      return {
        view: args.view ?? 'digest',
        summary,
        artists: artistRows,
        tracks: args.view === 'artists' ? [] : trackRows,
        sampleSize,
        note:
          tracks.length > 0
            ? '候选里的 source+id 是**已确认可直取**的，调用 music_play_song({source,id}) 可零搜索精确播放。'
            : '画像里还没有可直接播放的曲目；可以用 music_play_song({title,artist}) 精确确认一首。',
      }
    },
    presentCall: () => ({ card: 'generic', title: '查看音乐口味', kind: 'read', rawInput: {} }),
  })
}

// ── music_play_song ─────────────────────────────────────────────────────────

interface PlaySongArgs {
  source?: string
  id?: string
  title?: string
  artist?: string
  album?: string
  duration_sec?: number
  variant?: string
  mode?: string
  quality?: string
  prefer_like?: string[]
  prefer_dislike?: string[]
  context?: string
}

function buildPlaySongTool(options: TasteToolsOptions): ReturnType<typeof defineTool> {
  const { service, store, memory } = options
  const now = options.now ?? Date.now

  return defineTool({
    name: 'music_play_song',
    description:
      '精确播放一首**确定的**歌（推荐用它代替模糊搜索点播）。' +
      '已知平台 id 时传 {source,id}：直接命中画像里已确认的直取引用，零搜索；' +
      '否则传 {title,artist}（可带 album/duration_sec 提高准确度）：只按曲名+艺人精确确认，' +
      '确认不到会明确失败并给出候选，绝不会拿翻唱或别的版本顶替。' +
      'mode=explore 表示这是"没听过的探索"（负反馈会计入但打折）。',
    parameters: {
      source: { type: 'string', enum: MUSIC_SOURCES, description: '平台（配合 id 使用，走零搜索直取）。' },
      id: { type: 'string', description: '平台曲目 id（配合 source 使用）。' },
      title: { type: 'string', description: '曲名（与 id 二选一）。' },
      artist: { type: 'string', description: '歌手（强烈建议与 title 一起给）。' },
      album: { type: 'string', description: '专辑（可选，用于区分原唱/翻唱/Live）。' },
      duration_sec: { type: 'integer', description: '时长秒数（可选，用于区分版本）。' },
      variant: { type: 'string', enum: VARIANTS, description: '指定版本：original/live/cover/…（默认优先原唱）。' },
      mode: { type: 'string', enum: ['replay', 'explore'], description: 'replay=复听（默认）/ explore=探索没听过的。' },
      quality: { type: 'string', enum: ['128k', '320k', 'flac', 'flac24bit', 'flac32bit', 'wav'], description: '音质（可选）。' },
      context: { type: 'string', description: '当前情境（可选，如 frustrated/stuck/happy），用于学习情绪与音乐的关联。' },
      prefer_like: { type: 'array', items: { type: 'string' }, description: '顺带记录：用户在这次对话里明确表示喜欢的艺人/曲风（合并成一次调用，省一轮往返）。' },
      prefer_dislike: { type: 'array', items: { type: 'string' }, description: '顺带记录：用户明确表示不喜欢的。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          played: { type: 'boolean', required: true },
          title: { type: 'string', required: true },
          artist: { type: 'string', required: true },
          source: { type: 'string', required: true },
          id: { type: 'string', required: true },
          via: { type: 'string', required: true },
          variant: { type: 'string', required: true },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: { title: string; artist: string; via: string; variant: string; played: boolean; note: string }) =>
        [
          {
            type: 'text' as const,
            text: `${value.played ? '正在播放' : '已加入列表'}：${value.title} - ${value.artist}（${value.variant}，${value.via === 'profile' ? '画像直取' : '精确确认'}）`,
          },
          ...(value.note ? [{ type: 'text' as const, text: value.note }] : []),
        ],
    },
    execute: async (rawArgs) => {
      const args = rawArgs as unknown as PlaySongArgs
      const startedAt = now()
      if (!memory.enabled) throw new Error('音乐画像已关闭；请改用 music_play（搜索点播），或在设置页开启画像。')
      const mode = args.mode === 'explore' ? 'explore' : 'replay'
      const ctx = { origin: 'ai' as const, mode: mode as 'replay' | 'explore', ...(args.context ? { context: args.context } : {}) }

      // 顺带记录显式喜好（与点歌合并成一次调用，省一整轮 prompt 往返）
      const prefs = [
        ...(args.prefer_like ?? []).map((entity) => ({ entity, liked: true })),
        ...(args.prefer_dislike ?? []).map((entity) => ({ entity, liked: false })),
      ]
      if (prefs.length > 0) {
        const ts = now()
        const deltas = prefs
          .filter((p) => p.entity.trim())
          .map((p) => explicitDelta({ kind: 'artist', key: p.entity.trim(), liked: p.liked, provenance: 'explicit-chat' }))
        if (deltas.length > 0) {
          await store.applyDeltas(deltas, { now: ts, halfLifeDays: memory.halfLifeDays })
          await store.appendEvent({
            kind: prefs[0]?.liked ? 'like' : 'dislike',
            origin: 'ai',
            mode,
            ts,
            ...(args.context ? { context: args.context } : {}),
            deltas,
          })
        }
      }

      // ── Tier-1：平台 id 直取（零搜索）────────────────────────────────────
      if (args.source && args.id) {
        const found = store.findByRef(args.source, args.id)
        const music = found?.music as MusicInfo | undefined
        if (found && music) {
          try {
            await service.resolveUrl({ music, ...(args.quality ? { quality: args.quality as Quality } : {}) })
            runWithPlayContext(ctx, () => {
              const added = service.addMusic([music], 'tail')
              const idx = added.playlist.findIndex((m) => m.id === music.id && m.source === music.source)
              service.play({ index: idx })
            })
            await store.upsertTrackRef({
              trackKey: found.trackKey,
              title: music.name,
              artist: music.singer,
              music: found.music as MusicInfo,
              played: false,
              explored: mode === 'explore',
              resolved: true,
              now: startedAt,
            })
            options.onLog?.({
              time: new Date(startedAt).toISOString(),
              action: 'play-song',
              query: `profile:${args.source}:${args.id}`,
              limit: 1,
              autoPlay: true,
              source: music.source,
              resultsCount: 1,
              playedId: music.id,
              latencyMs: now() - startedAt,
            })
            return {
              played: true,
              title: music.name,
              artist: music.singer,
              source: music.source,
              id: music.id,
              via: 'profile',
              variant: (found.record.variant ?? 'unknown') as string,
              note: '来自画像里已确认的可播放引用（未进行任何搜索）。',
            }
          } catch (err) {
            // 直取失败不静默换歌：带上原因让上层决定（换平台 id 或改用 title/artist 确认）
            throw new Error(`画像直取播放失败（${args.source}/${args.id}）：${err instanceof Error ? err.message : String(err)}`, { cause: err })
          }
        }
        // 画像里没有这个 id → 明确告知，不猜测
        if (!args.title) {
          throw new Error(`画像里没有 ${args.source}/${args.id} 的记录；请改用 music_play_song({title,artist}) 精确确认。`)
        }
      }

      // ── Tier-2：按曲名 + 艺人精确确认 ────────────────────────────────────
      const title = (args.title ?? '').trim()
      if (!title) throw new Error('需要提供 {source,id}（画像直取）或 {title,artist}（精确确认）')
      const artist = (args.artist ?? '').trim()
      const query = artist ? `${title} ${artist}` : title
      const outcome = await service.search({ query, limit: 10 })
      const match = pickBestMatch(
        {
          title,
          ...(artist ? { artist } : {}),
          ...(args.album ? { album: args.album } : {}),
          ...(args.duration_sec !== undefined ? { durationSec: args.duration_sec } : {}),
          ...(args.variant ? { variant: args.variant as VariantKind } : {}),
        },
        outcome.results.map((m) => ({
          name: m.name,
          singer: m.singer,
          ...(m.meta?.albumName ? { albumName: m.meta.albumName } : {}),
          ...(m.interval ? { interval: m.interval } : {}),
        })),
      )

      if (!match) {
        const near = outcome.results
          .slice(0, 3)
          .map((m) => `${m.name} - ${m.singer}${m.interval ? ` (${m.interval})` : ''}`)
          .join('；')
        throw new Error(
          `没有与「${title}${artist ? ` - ${artist}` : ''}」精确匹配的曲目（已按曲名+艺人+版本严格校验）。` +
            (near ? `候选（都未通过校验，可能是翻唱/Live/时长不符）：${near}` : '搜索无结果。') +
            '请换一个确定存在的版本，或补上 album/duration_sec 帮助区分。',
        )
      }

      const target = outcome.results.find((m) => m.name === match.candidate.name && m.singer === match.candidate.singer) ?? outcome.results[0]!
      await service.resolveUrl({ music: target, ...(args.quality ? { quality: args.quality as Quality } : {}) })
      runWithPlayContext(ctx, () => {
        const added = service.addMusic([target], 'tail')
        const idx = added.playlist.findIndex((m) => m.id === target.id && m.source === target.source)
        service.play({ index: idx })
      })

      const targetDuration = secondsFromInterval(target.interval)
      await store.upsertTrackRef({
        trackKey: makeKey(target.name, target.singer),
        title: target.name,
        artist: target.singer,
        music: target,
        played: false,
        explored: mode === 'explore',
        resolved: true,
        variant: match.outcome.variant,
        ...(target.meta?.albumName ? { album: target.meta.albumName } : {}),
        ...(targetDuration !== undefined ? { durationSec: targetDuration } : {}),
        now: startedAt,
      })
      options.onLog?.({
        time: new Date(startedAt).toISOString(),
        action: 'play-song',
        query,
        limit: 10,
        autoPlay: true,
        source: target.source,
        resultsCount: outcome.results.length,
        playedId: target.id,
        latencyMs: now() - startedAt,
      })
      return {
        played: true,
        title: target.name,
        artist: target.singer,
        source: target.source,
        id: target.id,
        via: 'match',
        variant: match.outcome.variant,
        note: `精确确认通过（${match.outcome.reasons.slice(0, 3).join('；')}）。`,
      }
    },
    presentCall: (rawArgs) => {
      const args = rawArgs as unknown as PlaySongArgs
      return { card: 'generic', title: '精确播放', kind: 'other', rawInput: { title: args.title, artist: args.artist, id: args.id } }
    },
  })
}

// ── music_taste ─────────────────────────────────────────────────────────────

interface TasteArgs {
  action?: string
  kind?: string
  entity?: string
  note?: string
  limit?: number
}

function buildTasteTool(options: TasteToolsOptions): ReturnType<typeof defineTool> {
  const { store, memory } = options
  const now = options.now ?? Date.now
  const budget = BUDGET_PROFILE[memory.budget]

  return defineTool({
    name: 'music_taste',
    description:
      '读写用户的音乐口味记忆。当用户在对话里**明确表达**对某位艺人/某类音乐的喜欢或不喜欢时，' +
      '用 action=like/dislike 记录下来（这比行为推断更可靠，且不会随时间衰减）；' +
      'action=summary/top 读取画像；action=forget 让画像忘掉某个对象。不要凭一次提及就反复加权。',
    parameters: {
      action: { type: 'string', enum: ['summary', 'top', 'like', 'dislike', 'forget', 'note'], required: true, description: '操作。' },
      kind: { type: 'string', enum: ['artist', 'track', 'tag'], description: '对象类型（默认 artist）。' },
      entity: { type: 'string', description: '对象（艺人名 / 曲名 / 标签）。like/dislike/forget/note 需要。' },
      note: { type: 'string', description: 'note 用：一句自然语言记录（如"加班时想听安静的女声"）。' },
      limit: { type: 'integer', description: 'top/summary 的条目上限。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', required: true },
          ok: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
          items: { type: 'array', required: true, items: { type: 'string' } },
          note: { type: 'string', required: true },
        },
      },
      render: (_args, value: { summary: string; items: string[]; note: string }) => {
        const lines = [value.summary, ...value.items.map((i) => `- ${i}`)]
        if (value.note) lines.push(value.note)
        return lines.map((text) => ({ type: 'text' as const, text }))
      },
    },
    execute: async (rawArgs) => {
      const args = rawArgs as unknown as TasteArgs
      const ts = now()
      const action = args.action ?? 'summary'
      const kind = (args.kind ?? 'artist') as 'artist' | 'track' | 'tag'
      const entity = (args.entity ?? '').trim()

      if (!memory.enabled) {
        return {
          action,
          ok: false,
          summary: '音乐画像已关闭（用户可在设置页开启）。',
          items: [],
          note: '画像关闭时不会读取或写入任何数据。',
        }
      }

      if (action === 'summary' || action === 'top') {
        const limit = Math.max(1, Math.min(budget.candidates || 5, Math.floor(args.limit ?? (budget.candidates || 5))))
        const artists = store.top('artist', { now: ts, halfLifeDays: memory.halfLifeDays, limit })
        const tracks = store.top('track', { now: ts, halfLifeDays: memory.halfLifeDays, limit })
        return {
          action,
          ok: true,
          summary:
            artists.length > 0
              ? `近 ${memory.halfLifeDays} 天口味：${artists.map((a) => a.raw ?? a.key).join('、')}`
              : '还没有画像数据（多播放几首，或直接用 like 明确告诉画像）。',
          items: [
            ...artists.map((a) => `${a.raw ?? a.key}：${a.score.toFixed(2)}（${a.plays} 播放${a.skips ? ` / ${a.skips} 跳过` : ''}，置信度 ${a.confidence}）`),
            ...tracks.map((t) => `${(t as unknown as StoredTrack).title ?? t.key}：${t.score.toFixed(2)}`),
          ],
          note: '分数 = 隐式（按 90 天半衰期衰减）+ 显式（用户明确说过的，不衰减）。',
        }
      }

      if (action === 'note') {
        if (!args.note?.trim()) throw new Error('note 需要提供 note 字段')
        await store.appendEvent({ kind: 'note', origin: 'ai', mode: 'replay', ts, deltas: [] })
        await store.writeState({ ...store.readState(), summary: args.note.trim() })
        return { action, ok: true, summary: '已记下这条口味备注。', items: [], note: args.note.trim() }
      }

      if (!entity) throw new Error(`${action} 需要提供 entity`)

      if (action === 'forget') {
        const key = kind === 'track' ? entity : kind === 'tag' ? entity : normalizeArtist(entity)
        const removed = await store.forget(kind, key)
        await store.appendEvent({ kind: 'forget', origin: 'ai', mode: 'replay', ts, ...(kind === 'track' ? { trackKey: key } : { artistKey: key }) })
        return {
          action,
          ok: removed,
          summary: removed ? `已让画像忘掉「${entity}」。` : `画像里本来就没有「${entity}」。`,
          items: [],
          note: '遗忘只影响画像，不会删除播放列表或历史事件。',
        }
      }

      // like / dislike → 显式权重（不参与衰减）
      const liked = action === 'like'
      const delta = explicitDelta({ kind, key: kind === 'artist' ? normalizeArtist(entity) : entity, liked, provenance: 'explicit-chat' })
      await store.applyDeltas([delta], { now: ts, halfLifeDays: memory.halfLifeDays })
      await store.appendEvent({
        kind: liked ? 'like' : 'dislike',
        origin: 'ai',
        mode: 'replay',
        ts,
        ...(kind === 'track' ? { trackKey: delta.key } : { artistKey: delta.key }),
        deltas: [delta],
      })
      return {
        action,
        ok: true,
        summary: `已记录：${liked ? '喜欢' : '不喜欢'}「${entity}」（权重 ${delta.signal > 0 ? '+' : ''}${delta.signal}，不随时间衰减）。`,
        items: [],
        note: '如果用户只是顺口一提，可以稍后用 forget 撤销。',
      }
    },
    presentCall: (rawArgs) => {
      const args = rawArgs as unknown as TasteArgs
      return { card: 'generic', title: '音乐口味', kind: 'other', rawInput: { action: args.action, entity: args.entity } }
    },
  })
}

/** 注册画像工具集（music_profile / music_play_song / music_taste）。 */
export function registerTasteTools(ctx: { tools: { register(tool: unknown): void } }, options: TasteToolsOptions): void {
  ctx.tools.register(buildProfileTool(options))
  ctx.tools.register(buildPlaySongTool(options))
  ctx.tools.register(buildTasteTool(options))
}

/** 工具名清单（测试与文档用，避免手写字符串漂移）。 */
export const TASTE_TOOL_NAMES = ['music_profile', 'music_play_song', 'music_taste'] as const
