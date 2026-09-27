# 设计文档：音乐画像（Taste Memory）—— lx-music-for-dsh 1.2.0

> 目标：让 AI（尤其 **vibe-music** 主动点歌）**先读画像 → 报出一首确定的歌 → 精确播放**；
> 画像由本地算法从真实行为中生长，AI 可在对话中增删权重与语义标注。全部本地处理，不上传。
>
> 本文档的每条结论都尽量带**实测证据**；§2 的 6 项前置验证已完成，结论已并入各节。

---

## 1. 目标 / 非目标 / 不变量

**目标**
1. vibe-music 触发时，AI 能"先查画像、再点一首确定的歌"，而不是让厂商搜索引擎替它挑。
2. 日常行为（播放/跳过/完整/切歌）由**本地算法**自动加权编排成画像，零 token。
3. AI 可在对话中通过工具**影响画像**（"我喜欢金玟岐" → 写入显式权重 + 语义条目）。
4. 用户可见、可纠正、可清空；纯本地。
5. **细粒度音乐标签**（R&B / 摇滚 / 民谣…）：画像要能表达"口味在风格层面是什么"，而不只是"听了谁"。
6. **探索**：AI 有时要推荐**用户没听过、但在其喜好范围内**的歌，而不是只复读已听曲目。
   （目标 5、6 是同一个问题的两面：没有标签，"在喜好范围内"就无法定义。影响评估见 §18。）

**非目标**
- ❌ 向量库 / embedding 检索（理由见 §9）
- ❌ 把"按喜好重排搜索结果"当卖点（明确不作为主路径）
- ❌ 任何形式的数据上传
- ❌ 覆盖用户的明确指令

**三条不变量**
1. **事件流是唯一真源**：画像任何时候可从事件全量重算。
2. **权重只由本地确定性算法产出**；LLM 只写"注释"，不写"分数"。
3. **成本形状必须是"按事件"**，不是"按轮数"。

---

## 2. 前置验证结论（spike，已实测）

| # | 问题 | 实测结论 | 对设计的影响 |
|---|---|---|---|
| 1 | `layout` 行为与切换 | `single` = 单文件整份读写；`per-record` = 目录 + 一条一文件 | 必须切 per-record（否则 events 写放大爆炸） |
| 1b | single → per-record（同路径同版本） | ✅ open 成功；**表记录被"legacy bootstrap"自动播种**；旧文件**原样保留**；⚠️ **`global` 不会迁移**（回落到 schema `initial`） | **不能依赖自动迁移**：插件最要紧的播放列表/设置都在 global |
| 1c | per-record → single（回退） | ⚠️ open 成功但**读到空** | 回退不能靠切 layout；回滚靠"删 per-record 目录 + 旧文件仍在" |
| 1d | bootstrap 触发条件 | 仅当**新树还没有任何文档**时生效（任何新文档都会抑制） | 迁移有**时序陷阱**（见 §13） |
| 2a | per-record + schema 坏记录（默认） | ❌ open 失败 `invalid-record` | 默认严格太脆 |
| 2b | per-record + `invalidRecords:'backup-and-skip'` | ✅ open 存活；坏记录改名为 `k2.json.bak.<时间戳>`；JSON 损坏文件被静默当不存在；**重复 open 幂等** | **1.0.1 事故的正解**，必须启用 |
| 2c | single + 坏记录 | ❌ open 失败；**加 `backup-and-skip` 也仍然失败** | 该选项**只对 per-record 生效** → 两个决策绑在一起 |
| 3 | 插件能否影响系统提示 | ✅ `ctx.systemPrompt.section()` / `.context()` 可注册（section 进系统提示前缀；context 变成持久 user 快照） | "AI 自动看得到画像"可用 section 实现；但见 §10 的成本约束 |
| 4 | 插件能否自带 skill | ✅ `ctx.skills.register(SkillRegistration)` | 选歌流程可随插件版本化，不必改用户的 vibe-music 正文 |
| 5a | 五平台 id 形态 | 统一为 `"<平台>_<原生id>"`，如 `wy_2652820720` / `tx_0039MnYb0qxYhV` / `kg_20505418` / `kw_228908` / `mg_3790007`；meta 里另有 `songId/hash/copyrightId/strMediaMid/albumMid/albumName/picUrl` | 画像存**整条 MusicInfo** 即可，等于存了多重标识 |
| 5b | 版本（原唱/Live/翻唱）可区分性 | **`albumName` + `interval` 是强依据**：原唱晴天 = `叶惠美` + `04:29`；Live = 演唱会专辑 + `04:09/04:59`；翻唱者 singer 完全不同（RyaVocal / Lucky小爱 / GYBeat） | Tier-2 严格校验可行且可靠 |
| 5c | 模糊搜索的噪声 | 只搜"晴天"时，网易云前 6 条**全是翻唱/DJ 版**，没有周杰伦原唱；咪咕还会混入"圣诞星""我的地盘" | 印证"搜索不能当决策者"；Tier-2 必须严格过滤 |
| 5d | **Tier-1 是否成立** | ✅ **12/12 命中并可重复解析**（tx/kg/kw/mg × 3 首），且两次解析 URL 完全一致 | "画像直取、无需重新搜索"**成立** |
| 5e | 音源脚本现实 | 4 个脚本合计覆盖 `wy,tx,kg,kw,mg`，但单个脚本会 timeout/404，靠**引擎轮询**兜底 | 画像要**存多平台 id** 做兜底 |
| 6 | 插件能否调用模型 | ✅ `ctx.llm.stream(options)` 存在 | P1 的"离线语义提炼"可行 |

---

## 3. 七条设计原则

| # | 原则 |
|---|---|
| 1 | **检索前置，但不是向量检索**（要 RAG 的流程，不要 embedding 的实现） |
| 2 | **搜索从"决策者"降级为"身份翻译器"**（首次必须搜，之后直取） |
| 3 | **画像只做补充，绝不覆盖明确指令** |
| 4 | **explicit 不衰减，implicit 衰减** |
| 5 | **归因三拆**：曲目 / 艺人 / 版本 |
| 6 | **计算全本地，token 只花在决策上** |
| 7 | **缓存友好**：工具描述静态，动态数据只走返回值 |

---

## 4. 架构总览

```
用户行为 ─┐
AI 主动选歌 ─┼→ [捕获层 host] → taste_events（append-only，仅终态结算，零 token）
对话表态 ─┘                          │
                                     ↓ [L1 本地聚合] 增量 + 指数衰减 + 置信度 + 共现图
        taste_tracks / taste_artists / taste_tags / taste_state
                                     ↓ [L2 语义标注：LLM，低频/离线/结构化/可禁用]
        taste_facets（风格簇命名 / 情绪↔歌关联 / 原话 facets）
                                     ↓ [L3 本地模板渲染]
   ① music_profile   ← vibe-music 主入口（确定候选 + id + 理由）
   ② music_play_song ← 两级解析（画像直取 / 精确确认）
   ③ music_taste     ← 读写（like/dislike/forget/note+facets）
   ④ 「我的口味」页 + 首启引导
```

---

## 5. 数据模型（domain v2）

```ts
defineDomain({
  name: 'lx_music',
  version: 1,                        // ★ 保守：spike 1b/1c 表明升 version 无收益、有丢数据风险
                                     //   （per-record 下"不接受的版本戳会丢弃记录"，不是迁移）
  layout: 'per-record',              // ★ 一条一文件；single 下 backup-and-skip 无效（spike 2c）
  invalidRecords: 'backup-and-skip', // ★ 坏记录改名备份，不再殉爆整个 open（spike 2b）
  global: {
    schema: { /* 现有字段原样保留 */ , memory: { enabled, onboardedAt, snoozedUntil,
              halfLifeDays: 90, retainDays: 90, budget: 'balanced',
              semanticProfile: 'local-only', profileCallsPerHour: 20 } },
    initial: { /* 现有 initial 原样 */ , memory: { enabled: true, ... } },
  },
  tables: {
    logs, sources, source_order,     // 保留不动
    taste_events, taste_tracks, taste_artists, taste_tags,
    taste_genres, taste_genre_edges,  // 细粒度风格标签 + 标签邻接（§18.1）
    taste_facets, taste_state,
  },
})
```

| 表 | key | value（要点） | 上限 |
|---|---|---|---|
| `taste_events` | 递增序号 | `{ ts, kind, origin, context?, mode:'replay'\|'explore', query?, source?, musicId?, title?, artist?, playedRatio?, signal }` | 90 天 / ≤5000 条 |
| `taste_tracks` | `normTitle\|normArtist` | `{ canonical:{title,artist,album?,durationSec}, variant:{kind,confidence}, ids:{[source]:{id,meta,lastOkAt,lastResolvedAt,lastScript}}, **status:'seen'\|'played'**, **playCount**, **lastExploredAt?**, implicit, explicit, plays, skips, lastTs }` | ≤2000 |
| `taste_artists` | `normArtist` | `{ raw, implicit, explicit, plays, skips, lastTs, facets? }` | ≤500 |
| `taste_tags` | `platform:tx` / `quality:flac` / `hour:night` / `mood:frustrated` | `{ score, count, updatedAt }` | ≤200 |
| `taste_genres` | 受控标签 id（`rnb` / `rock` / `mandopop` …） | `{ label, parent?, rawScore, normScore, artistCount, trackCount, explicit, updatedAt }`（`normScore` 按基数归一化，见 §18.1） | ≤120 |
| `taste_genre_edges` | `rnb\|soul` | `{ distance: 1\|2, source:'llm'\|'user', updatedAt }`（探索放宽用的邻接，§18.2） | ≤400 |
| `taste_facets` | `artist:金玟岐` / `cluster:3` | `{ label, kind:'genre'\|'mood'\|'cluster'\|'note', text, evidence, provenance, confidence, taxonomyVersion?, ts }` | ≤500 |
| `taste_state` | `summary` | `{ text, topArtists[], sampleSize, generatedAt, migratedFrom?, **exploreStats** }` | 1 |

**explicit / implicit 分离**（原则 4）：`score = implicit(半衰期 90 天) + explicit(不衰减)`。
理由：用户说"我喜欢金玟岐"，三个月没听也不该被衰减抹掉。

**`status: 'seen' | 'played'` 是探索功能的前提**（§18.2 的坑 1）：
Tier-2 校验通过只代表"身份确认过"，**不等于听过**。若把 seen 也写进"已听"池，
探索几次之后"没听过的歌"就枯竭了。

---

## 6. 主链路（vibe-music 触发）

```
skill 决定情境（烦躁 / 卡住 / 愉悦 / 专注）
  ↓ ① 指令来自**插件自带的 skill**（spike #4）或 vibe-music 正文，仅触发时加载 → 编码轮零成本
  ↓ ② music_profile({ view:'for-mood', mood:'frustrated', limit:5 })
       → 确定候选：title / artist / source / musicId / quality / score / 理由 / 最近是否听过
  ↓ ③ 模型选 1 首 → music_play_song({ source, id })      ← 画像直取（Tier-1，实测成立）
       （画像外：music_play_song({ title, artist, album?, durationSec? }) → 严格校验，不匹配就失败）
  ↓ ④ host 结算事件 → 本地更新画像（含"AI 在此情境选了这首、结果如何"的归因）
```

---

## 7. 两级解析与匹配规则

| 层 | 条件 | 行为 |
|---|---|---|
| **Tier-1 画像直取** | `normTitle\|normArtist` 命中 `taste_tracks` | 取出存下的完整 `MusicInfo`（含 source+id+meta）→ 直接喂现有 `resolveUrl`。**零搜索**（实测 12/12 可重复解析） |
| Tier-1 兜底 | 该平台解析失败 | 换画像里**另一个平台 id** 重试（spike 5e：脚本平台覆盖不一致，必须跨平台兜底） |
| **Tier-2 精确确认** | 画像未命中（首次） | 按 `title+artist` 搜 → **严格校验** → 通过则写回画像 |
| 失败 | Tier-2 无合格匹配 | **明确失败** + 给近似候选让模型改；**绝不静默取第 0 个**（spike 5c：wy 前 6 条全是翻唱） |

**Tier-2 严格校验规则**（依据 spike 5a/5b）：
1. `normName === normName` 且 `normSinger === normSinger`（归一后严格相等）
2. **版本判定优先用 `albumName` + `interval`**：
   - 请求未指定版本 → 优先 `albumName` 非空、非演唱会/Live/伴奏/remix 关键词，且时长与候选众数接近者
   - `interval` 容差 ±3 秒（实测原唱 04:29/04:30，Live 04:09/04:59 差异明显）
3. singer 归一化优先，若平台返回多人（如 `周杰伦 / 杨瑞代`）取主歌手比对

**归一化规则**：去括号后缀（Live/伴奏/remix/纯音乐/feat.）、全角半角、大小写、空白与标点；艺人走别名表 + 平台规范名。
**时效区分**：平台曲目 id **长期存**；解析出的**直链 URL 永不缓存**（实测同刻重放一致，但脚本直链普遍带时效参数）。

---

## 8. 工具面

| 工具 | 类型 | 关键参数 | 输出上限 |
|---|---|---|---|
| **`music_profile`** | 读 | `view:'digest'\|'artists'\|'tracks'\|'for-mood'\|'genres'\|'explore-brief'\|'notes'`, `mood?`, `novelty?`, `limit?` | digest ~150 tokens；详细 ~800 tokens；候选 ≤8 |
| **`music_play_song`** | 写 | `{source,id}` 优先；退化 `{title,artist,album?,durationSec?,variant?}`；可选 `prefer:{like:[],dislike:[]}`（合并写回）；`mode:'replay'\|'explore'`（默认 replay） | ≤200 |
| **`music_taste`** | 读写 | `action:'summary'\|'top'\|'like'\|'dislike'\|'forget'\|'note'\|'tag'`; `kind:'artist'\|'tag'\|'genre'\|'song'`; `tags?:string[]`; `facets?` | ≤200 |
| `music_play` | 兼容 | 保留模糊搜索；描述引导"已知歌名请用 `music_play_song`" | 不变 |
| ~~搜索结果重排~~ | 降级 | 不再是卖点；最多作 fallback 候选提示 | — |

**工具描述必须静态**（原则 7）：任何动态内容进描述都会让整张工具表的 prompt 缓存失效。

**`view:'explore-brief'` 返回的不是成品歌单，而是探索约束**（§18.2）：
种子艺人、允许的标签集合（含邻接放宽）、排除清单（已听/最近探索过的组合）、以及"别重复覆盖的角落"提示。
由**模型据此提出具体的歌曲身份**，再走 `music_play_song` 的 Tier-2 严格校验——这保持了
"AI 点的是确定的歌、搜索引擎只做身份翻译"这条原则。

---

## 9. 画像绘制：本地 vs LLM 的分工

| 层 | 内容 | 谁做 | 成本 | 可重建 |
|---|---|---|---|---|
| L0 事件 | 播放/跳过/完整/点歌/显式表态 | host 本地 | **0** | 真源 |
| L1 统计画像 | 权重、指数衰减、置信度、共现图、时段/平台/音质 | **本地算法** | **0** | ✅ |
| L2 语义标注 | 风格簇命名、情绪↔歌关联、原话→facets | **LLM（低频/离线/结构化/可禁用）** | 极低 | ✅ 可丢弃重生成 |
| L3 渲染 | 给模型读的 digest、给 UI 的榜单 | **本地模板**（可选 LLM 润色） | 0～极少 | ✅ |

**三条关键结论**
1. **权重永远本地算，LLM 只写注释不写分数** → 可解释、可重建、不被幻觉带偏。
2. **语义层优先"借用正在对话的 agent"**（成本已付过）：用户说"我喜欢金玟岐"那一轮，让模型顺手把 facets 一起写进 `music_taste`。
3. **本地能替代的比想象的多**：本地算**共现图**（哪些艺人常在同一 session 连着被听），LLM 只给簇**起名字** → 极小 token 换很大语义价值。

**LLM 介入方式（按推荐顺序）**

| 方式 | 时机 | 额外调用 | 说明 |
|---|---|---|---|
| A. 借用当前 agent | 对话中表态时 | **0** | **P0 就用这个** |
| B. 离线批量提炼 | 每 N 条事件 / 每日 | 1 次/天（~1k tokens） | 输入=top 统计+近期 note；输出强制结构化 JSON + zod 校验，不合法即丢弃（用 `ctx.llm.stream()`，spike #6 ✅） |
| C. 惰性手动 | 用户点"重新分析" | 手动 | 失败可退 |
| D. 请求路径上 | ❌ 不做 | 每次点歌 | 成本形状错误 |

**优雅降级**：`semanticProfile: 'off' \| 'local-only' \| 'llm-assisted'`；关掉 LLM 层画像依然完整可用。

**为什么不用向量库**：① 规模不需要（几百实体 / 几万事件，filter+sort 即可）；② embedding 必须调外部模型 → **违背"不上传"**（DSH 无本地 embedding）；③ 结构化更准更可解释；④ 删除/重建成本低；⑤ 依赖与体积（当前 bundle 311KB，向量库要翻几倍）。

---

## 10. 成本模型与硬护栏

| 项 | 频率 | tokens |
|---|---|---|
| 事件结算 / 本地聚合 / 共现图 | 每次播放、后台 | **0** |
| `music_profile` digest | 每次点歌 | ~100–150（本地模板渲染） |
| 候选返回 | 每次点歌 | ~300–500 |
| 常驻画像注入 | 每轮 | **不做** ❌（乘轮数 + 破坏缓存） |

**硬护栏**
1. `music_profile` 结果 ≤ ~800 tokens，候选 ≤8，理由 ≤12 字；超限截断并标注。
2. `profileCallsPerHour`（默认 20，复用现有滑动窗口限流器），超限提示直接用 `music_play_song`。
3. **绝不让模型读原始事件流**；只读聚合后的画像。
4. 摘要用**本地模板**渲染，不用 LLM 生成（P1 的 note 提炼才用 LLM，且低频）。
5. **工具描述静态**（缓存友好）。
6. `memoryBudget: 'off' | 'minimal' | 'balanced' | 'rich'`（默认 balanced：5 候选 + 一句理由）。
7. **"先查画像"的指令放进 skill 正文**（仅触发时加载）→ 编码轮零成本；**不注入系统提示**。
   - 若后续确需常驻：只放 ≤20 tokens 的能力指针，放**系统提示末尾**（保前缀缓存）。

**成本可见**：设置页显示"本月音乐画像相关消耗约 X tokens"（本地按字符估算）。
**量级**：3 次点歌/小时 ≈ 1.5k tokens/小时，与读一次代码文件同量级；**编码轮零影响**。

---

## 11. UI 与交互

- **首启引导**（默认开，可"稍后"→ `snoozedUntil = +7 天`）：总开关、显式喜好种子（艺人/平台/音质）、数据控制、一行"**全部在本机 `$DSH_HOME` 处理，不上传**"。
- **「我的口味」页**：榜单（艺人/曲目/标签）、证据（播放/跳过次数）、单条删除、"忘记这个艺人"、一键清空、保留期、预算档位、语义层开关、成本显示。
- **可解释标注**：发生重排或推荐时输出 `（依据你的口味：金玟岐 · 近 90 天）`。
- **撤销**：AI 对话写入带 `provenance:'chat'`，可一键回滚。

---

## 12. 隐私与治理

纯本地；原始事件含 query 原话 → **只留有限窗口（默认 90 天）**，聚合长期保留；一键清空后画像同步收敛；聚合层不落 query 原文（可配脱敏）。
**既成事实**：`$DSH_HOME/storages` **跨 profile 共享** → web 与 desktop 共用同一份画像（是特性，需写进文档）。

---

## 13. 迁移方案（按 spike 修正）

**关键约束**（spike 1b/1c/1d）：
- 自动 bootstrap **只播种表记录，不迁移 `global`** —— 而插件最要紧的数据（播放列表/当前索引/音质/音量/静音/播放模式/设置）全在 `global`。
- bootstrap **只在新树完全为空时生效** —— 若先写了任何新文档，表数据就播种不进来（时序陷阱）。
- per-record → single 读到空 → **回退不能靠切 layout**。

**迁移流程（显式，不依赖 bootstrap）**

```
0. 幂等检查：若新 domain 的 global.memory.migratedFrom 已存在 → 直接跳过 1~3
1. 用【旧 spec（single, version 1）】打开 → 读出 global（playlist/currentIndex/quality/
   volume/mute/playMode/settings）与需要的表数据 → 关闭
2. 用【新 spec（per-record, invalidRecords:'backup-and-skip'）】打开
   （此时新树为空，若旧文件仍在，backend 可能顺带播种表记录；我们随后显式覆盖，保证一致）
3. 把第 1 步读到的 global 写入新 domain，并写入 migratedFrom: 'single@<ts>'
4. 旧 `lx_music.json` **保持不动**（backend 从不修改/删除它）→ 天然备份
```

**回滚**：删除 per-record 目录 → 旧文件仍在 → 旧版插件可继续按 single 读取。
**测试要点**：幂等重跑、部分失败可恢复、旧文件未被改动、迁移后 playlist/settings 与迁移前逐字段一致。

---

## 14. 测试与验收

| 类别 | 用例 |
|---|---|
| 迁移 | 幂等重跑；旧文件未被改动；迁移后 global 逐字段一致；部分失败可恢复 |
| 韧性 | 塞 schema 坏记录 → `backup-and-skip` 生效、open 存活、备份文件名 `.bak.<ts>`；JSON 损坏文件被当不存在 |
| 纯函数 | 信号表；指数衰减；归一化与别名；**版本识别（用 spike 5b 的真实数据做样例：叶惠美/04:29 vs Live/04:09）**；重排确定性；探索配额；置信度门控 |
| 等价性 | 增量聚合 == 全量重算；裁剪不破坏聚合 |
| 语义 | explicit 不衰减（时间旅行测试）；LLM 输出 zod 校验失败即丢弃；语义层关闭后画像仍可用 |
| 两级解析 | Tier-1 命中 → 零搜索；Tier-1 解析失败 → 换平台 id → Tier-2；Tier-2 不匹配 → 明确失败 |
| **标签** | 受控词表 enum 校验（词表外标签被拒）；别名归一（R&B/rnb/节奏布鲁斯 → 同一标签）；**基数归一化**（构造"流行覆盖广"的数据，验证细粒度标签不被淹没）；词表版本变化触发重标；显式标签经共现图传播 |
| **探索** | `seen` 不被当作 `played`（探索 5 首只播 1 首 → 未听池只少 1）；去重窗口内不重复探索；探索负反馈按系数打折（构造"探索 3 次失败"验证新艺人未被压死）；探索率自适应（完整播放率高→升，连续秒切→降）；`exploreStats` 分组统计 |
| 成本 | 结果 ≤ 上限；`profileCallsPerHour` 限流；工具描述不含动态内容；**标签标注幂等**（同词表版本不重复调用 LLM） |
| 契约 | Remote 双向一致（现有测试自动覆盖新方法） |
| 隐私 | 清空事件后画像收敛；聚合层不落 query 原文 |

---

## 15. 分期路线

| 阶段 | 交付 | 验收 |
|---|---|---|
| **P0（1.2.0）** | per-record + `invalidRecords` + 显式迁移；L0/L1；`music_profile`；`music_play_song`（两级 + `status: seen/played`）；`music_taste`（读写+facets）；**插件自带 skill（`ctx.skills.register`）**承载"先查画像"流程；首启引导 + 「我的口味」页；**基础探索：同艺人未听曲目**（不需要标签，§18.3） | vibe-music 触发后能"先查画像 → 精确播放"；能推荐同艺人的未听曲目；成本符合预算；测试全绿 |
| **P1（1.2.x）** | **细粒度标签**：受控词表 + artist 级批量标注 + 基数归一化（§18.1）；**跨艺人探索**：标签邻接放宽 + 去重窗口 + 自适应探索率 + 评估分组（§18.2）；别名/版本识别强化；离线语义标注（`ctx.llm.stream`）；成本可见；撤销/去重 | 画像能表达"口味在风格层面"；探索能跳出已听且仍在范围内；探索指标可分组评估 |
| **P2（1.3+）** | 冷启动问卷；语义召回（**先试"给模型读小列表"，不引向量库**）；导入导出；相似艺人（谨慎引依赖）；标签词表人工编辑入口 | 冷启动体验 + 召回增益可量化 |

---

## 16. 风险与对策

| 风险 | 对策 |
|---|---|
| 归一化不足 → 证据碎片化 | 别名表 + `albumName`/`interval` 辅助 + 平台规范名 + 人工修正入口 |
| 翻唱污染 | 版本识别（albumName+interval）+ 归因三拆 |
| AI 自身选择带偏画像 | `origin` 归因 + 折扣权重 |
| 信息茧房（只复读已听） | 探索模式 + 可解释 + 可关闭（§18.2） |
| **反向茧房**（探索被跳过 → 新艺人被永久压低） | 探索曲的负反馈**额外打折**（§18.2 坑 3） |
| **探索池枯竭** | `status: seen/played` 分离 + 去重窗口（§18.2 坑 1/4） |
| **标签碎片化**（"R&B"/"节奏布鲁斯"/"Rnb"） | 受控词表 + LLM 只能从 enum 里选 + 别名映射（§18.1） |
| **标签粒度失真**（"流行"覆盖广 → 永远第一） | 按标签基数的归一化分数 `normScore`（§18.1） |
| 存储膨胀 | per-record + 上限 + 裁剪 |
| 隐私 | 本地 + 保留期 + 一键清空 |
| 成本失控 | §10 护栏 + 档位 + 缓存友好；标签是**幂等缓存**不重算（§18.4） |
| **迁移丢 global** | 显式迁移（§13）+ 幂等标记 + 旧文件不动 |
| 音源脚本平台覆盖不全 | 画像存多平台 id + Tier-1 跨平台兜底（spike 5e） |
| 标签标注质量差（LLM 幻觉） | 只用受控词表 + zod 校验 + 只标 top-N + 用户可改（§18.1） |

---

## 17. 发布

`1.2.0`（minor：新增能力）。走已就绪的 CI OIDC 流水线（tag 驱动、`--provenance`）；
**发版后必须把 tarball 传成 Release asset**（GitHub 安装路径依赖它）；`latest` 与 `lts` 双 tag。

---

## 18. 影响评估：细粒度标签与探索

> 这两条要求动到了原规划的两个隐含假设，必须显式修订。**核心结论：它们是同一个问题**——
> 没有细粒度标签，"在喜好范围内"就无从定义，探索只能靠模型瞎猜。

### 18.0 先说挑战总览

| # | 挑战 | 为什么是问题 | 落在哪一节修订 |
|---|---|---|---|
| 1 | **genre 不在 SDK 元数据里** | spike 5a 实测 meta 只有 `songId/hash/copyrightId/strMediaMid/albumMid/albumName/picUrl`，**没有风格字段** → 标签只能"推断"，不能"读取" | §9 新增 L2 职责、§18.1 |
| 2 | **L2 语义层从"可选装饰"升级为"功能要害"** | 原设计里关掉语义层画像依然完整；现在关掉就没有细粒度标签 → 探索退化 | §9 优雅降级需分档、§18.1 |
| 3 | **标签会碎片化** | LLM 每次可能输出 "R&B"/"节奏布鲁斯"/"Rnb"/"R and B" —— 比艺人别名更难对齐（没有平台规范名可借） | §18.1 受控词表 |
| 4 | **标签粒度不均** | "流行"覆盖半个歌单 → 原始累加必然排第一，细粒度标签被淹没 | §18.1 基数归一化 |
| 5 | **`seen` 与 `played` 混淆（我原设计的真实 bug）** | 探索时 Tier-2 会确认身份但未必播放；若把 confirmed 写进"已听"池，探索几次后池子枯竭 | §5 schema + §18.2 坑 1 |
| 6 | **"未听过"的候选从哪来** | Tier-1 只返回**已播过**的曲目，按定义零新颖性 | §18.2 候选来源 |
| 7 | **探索会反向污染画像** | 新艺人被探索后若被跳过，负反馈会把新艺人永久压低 → 反向茧房 | §18.2 坑 3 |
| 8 | **探索失败是正常的** | 探索本就该有更高跳过率；用同一阈值判"画像不准"会误判 | §18.2 评估分组 |
| 9 | **固定探索率不适用** | 20% 写死既可能太烦也可能太少 | §18.2 自适应 |
| 10 | **成本** | 若每首歌都让 LLM 打标签 → 成本爆炸 | §18.4 |

### 18.1 细粒度标签（genre）怎么产生

**关键判断：标签是"推断产物"，必须走受控词表 + 本地缓存 + 幂等重算。**

| 维度 | 设计 | 理由 |
|---|---|---|
| **词表** | 内置**受控标签表**（两段式：大类 `pop/rock/electronic/folk/hiphop/jazz/classical` → 子类 `rnb/indie-rock/mandopop/citypop/…`），LLM **只能从 enum 里选**，输出走 zod 校验，不合法即丢弃 | 解决挑战 3；同时给出层级，供探索放宽 |
| **标注粒度** | **artist 级为主**（低基数）、**track 级为例外覆盖**（同一艺人跨风格时） | 成本：artist 数远小于 track 数 |
| **标注时机** | **惰性 + 阈值触发**：只标 implicit+explicit 权重前 N 的艺人；**批量**（一次 30–50 个艺人）；**幂等缓存**（标签不像口味会频繁变，只在词表版本变化时重标） | 解决挑战 10 |
| **种子与传播** | 用户/AI 显式说的标签（`music_taste({action:'tag'})`）作为**种子**，沿**本地共现图**传播给常一起被听的艺人 | 让用户自己的词汇（"R&B"）映射到他的真实收听图，**零额外 LLM 成本** |
| **分数聚合** | `rawScore = Σ 该标签下艺人/曲目的 implicit+explicit`；`normScore = rawScore / log(1 + artistCount)`（基数归一化） | 解决挑战 4 |
| **可解释** | UI 显示"R&B（来源：陶喆、方大同；置信度中）"，可手动增删标签 | 用户可纠正 |

**对原规划的修订**：
- §9 的 L2 职责从"风格簇命名"扩展为"**genre 标注（受控词表）+ 簇命名**"。
- 优雅降级改为三档：`off`（无标签，探索退化为同艺人）／`local-only`（共现簇 + 显式种子传播，**零 LLM**）／`llm-assisted`（LLM 批量标注 + 邻接生成）。
  → **注意：`local-only` 档仍能做"同艺人未听曲目"探索**（不需要标签），这是 P0 就能上的原因。

### 18.2 探索（跳出已听，但仍在范围内）

**候选来源（三条，按可靠性排序）**

| 来源 | 做法 | 是否需要标签 | 是否需要新 API |
|---|---|---|---|
| ① **同艺人未听曲目** | 按艺人名搜索（spike 5a 实测：搜索会返回该艺人的其他歌，如搜"晴天 周杰伦"返回了《一路向北》《稻香》）→ 排除已 played | ❌ | ❌ |
| ② **同专辑未听曲目** | 按"歌手 + albumName"搜 → 过滤 `albumName` 相同者 | ❌ | ❌ |
| ③ **跨艺人同标签** | 由**模型**依据 `explore-brief` 提出具体歌手/歌曲身份 → Tier-2 严格校验 | ✅ | ❌（模型提供知识） |

**"在喜好范围内"的可操作定义**：允许 **同标签** 或 **`taste_genre_edges` 一跳邻接**的标签；
标签邻接由 LLM 一次性生成（R&B↔Soul、摇滚↔独立摇滚…）+ 用户可改，本地长期使用。

**四个必须处理的坑**

1. **`seen` ≠ `played`**（挑战 5）：探索走 Tier-2 确认身份后**只标 `seen`**；只有真正播放成功且
   播放比例达标才升为 `played`。否则探索池会枯竭。
2. **去重窗口**：同一首歌 N 天（默认 60）内不重复探索；同一艺人连续两次探索之间至少间隔 M 次播放。
3. **探索的负反馈必须额外打折**：探索曲被 15 秒切走 → 对该新艺人的负反馈系数设为普通的
   1/4（而非 AI-origin 的 1/2）。否则几次探索失败就会把整个新艺人群落压下去（**反向茧房**）。
4. **探索指标必须分组统计**：`exploreStats` 分开记录 replay/explore 的跳过率与完整播放率；
   **探索的高跳过率是预期行为，不能用来判定"画像不准"**。

**自适应探索率（取代写死的 20%）**
- 起点 20%；每次探索结算后按小步长调整：
  - 探索完整播放率 ↑ → 提高探索率（上限 35%）
  - 连续 N 次探索被秒切 → 降低（下限 5%）
- 触发点：`music_profile({view:'for-mood'|'explore-brief'})` 按当前探索率决定"这次是否走探索"，
  并在返回里明确告知模型（`mode: 'explore'`），让模型知道这次可以挑没听过的。

**与"AI 点确定的歌"原则的一致性**：探索**不引入模糊搜索决策**。
它只是把候选来源换成"同艺人/同标签的未听曲目"，并且仍然要求模型**给出确定身份**、
插件**严格校验**（spike 5b 的 albumName+interval 规则在探索里同样适用，能防止把翻唱当原唱放进来）。

### 18.3 分期上的调整

- **P0 就能做基础探索**：来源 ① ②（同艺人/同专辑未听）**不需要标签**，只需 `status: seen/played`
  与去重窗口。这样"跳出已听"在 1.2.0 就可用。
- **P1 做细粒度标签与跨艺人探索**：受控词表 + 批量标注 + 邻接 + 自适应 + 指标分组。

### 18.4 成本影响（结论：可控）

| 新增项 | 频率 | 估算 |
|---|---|---|
| artist 级 genre 批量标注 | 词表版本变化时 / 增量（新进 top-N 艺人） | 一次 30–50 艺人 ≈ 800–1500 tokens，**幂等缓存不重算** |
| 标签邻接生成 | 一次性（词表版本变化时） | ~500 tokens，本地长期使用 |
| `explore-brief` | 每次探索点歌 | 复用 `music_profile` digest，**不新增调用** |
| 探索曲身份校验 | 同 Tier-2 | 无额外 LLM 成本（本地校验） |
| 常驻成本 | — | **仍然为 0**（不注入系统提示，靠 skill 正文） |

**量级不变**：探索不改变"每次点歌一次工具调用"的成本形状（§10 的结论依然成立）。
唯一新增的是**低频、幂等的批量标注**，属于 P1 且可关闭。

### 18.5 不用改的部分（已确认不受影响）

- §1 三条不变量、§3 七条原则 —— 完全适用（探索反而更契合"搜索只做身份翻译"）。
- §7 两级解析与匹配规则 —— 探索的 Tier-2 复用同一套规则。
- §13 迁移方案 —— 与本次修订无关。
- §10 成本护栏与缓存友好 —— 结论不变。
- §2 的 6 项 spike 结论 —— 全部仍然有效；**本次修订没有引入需要重新 spike 的未知**。


