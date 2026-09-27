// 插件自带的 skill（通过 `ctx.skills.register()` 贡献，见 docs/design-taste-memory.md §9）。
//
// 为什么用 skill 承载"先查画像"的流程，而不是注入系统提示：
//   - skill 正文**只在被触发时加载** → 编码轮零 token 成本（成本模型的地基）；
//   - 流程随插件版本走，用户不必手改自己的 skill；
//   - 系统提示注入会按轮数计费，且动态内容会破坏 prompt 前缀缓存。

import type { SkillRegistration } from '@deepseek-ai/dsh-skill'

/** 运行时 skill 名（kebab-case，供模型/用户寻址）。 */
export const TASTE_SKILL_NAME = 'taste-aware-picking'

/**
 * 正文刻意写得**短而可执行**：模型读它是为了知道"先做什么、再做什么"，
 * 而不是读一篇设计文档。所有细节都在工具描述与工具返回值里。
 */
export const TASTE_SKILL_CONTENT = `# 按口味点歌（先查画像，再精确播放）

用户让你放歌、或你在编码/调试中想主动换一首歌时，按这个顺序做：

1. **先查画像**（不要凭空猜用户喜欢什么）：
   - 有具体情境（烦躁/卡住/愉悦/专注）→ \`music_profile({view:"for-mood", mood:"<情境>"})\`
   - 想换一首同类型的 → \`music_profile({view:"digest"})\`
   - 想推荐没听过的 → \`music_profile({view:"explore-brief"})\`
2. **挑一首确定的歌**：候选里带 \`source\`+\`id\` 的是已确认可直取的，优先选它们。
   不要用"轻音乐""舒缓的歌"这类模糊词去搜索——那等于把选择权交给搜索排序。
3. **精确播放**：
   - 候选来自画像 → \`music_play_song({source, id})\`（零搜索）
   - 自己想放一首 → \`music_play_song({title, artist, album?, duration_sec?})\`
   - 探索新歌 → 加 \`mode:"explore"\`（探索被切走时对艺人的负反馈会大幅打折）
   如果它明确告诉你"没有精确匹配"，就换一首，别退回模糊搜索硬放。
4. **顺手记住用户说的话**：用户明确表达喜欢/不喜欢某位艺人或某类音乐时，
   调用 \`music_taste({action:"like"|"dislike", entity:"<名字>"})\`。
   只是顺口一提、或你自己推断的，不要急着加权。

## 什么时候不要用

- 画像为空或已被用户关闭时：直接问用户想听什么，或用 \`music_search\` 正常搜索。
- 用户点名了具体的歌：直接用 \`music_play_song\` 精确播放，不必先查画像。
- 用户沉浸专注、没有换歌信号时：不要打扰。
`

/** 注册给 \`ctx.skills.register()\` 的定义。 */
export const TASTE_SKILL: SkillRegistration = {
  name: TASTE_SKILL_NAME,
  description:
    '按用户的音乐口味点歌：先读本地口味画像（music_profile），再挑一首确定的歌精确播放（music_play_song）。' +
    '主动换歌、推荐没听过的歌、用户让你放歌时使用。',
  content: TASTE_SKILL_CONTENT,
  /** 运行时贡献的来源桶（prompt 可见的元数据，不影响优先级）。 */
  source: 'runtime',
  metadata: { provider: 'lx-music-for-dsh' },
}
