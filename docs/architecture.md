# 架构与阅读指南

面向**要读代码/改代码的人**。目标：让你在 10 分钟内知道「东西在哪、数据怎么流、哪些约束不能碰」。

其它文档的分工：[technical notes](internals.md)（安全模型 / 存储 / 排查手册）、
[development.md](development.md)（构建 / 调试 / 打包 / 安装 / 验收）、
[versioning.md](versioning.md)（插件 × DSH 版本台账，**版本问题的唯一事实来源**）、
[design-taste-memory.md](design-taste-memory.md)（画像算法设计）。

---

## 1. 一句话定位

一个 DSH 插件：**host 半边**（Node）提供「音乐搜索 + 直链解析 + 播放权威状态 + LLM 工具」，
**client 半边**（浏览器）提供「侧边栏卡片 + 主窗口 + 设置窗口 + HTML5 Audio 播放」。
搜索用内置 SDK（移植 lx-music-desktop 的五平台），直链用**第三方音源脚本**在**独立子进程**里执行。
不需要任何外部服务。

发布产物三个，都由 `npm run build`（rollup）生成，**都不要手改**：

| 产物 | 来源 | 说明 |
|---|---|---|
| `lib/index.js` | `src/index.ts` | host 插件（ESM；external = `@deepseek-ai/*` / `zod` / `schemastery` / `node:`） |
| `lib/client.js` | `src/client.ts` | 浏览器 bundle（CJS，包在 `window.__ModuleLoader__.load` 里；external = DSH 客户端基线模块表） |
| `lib/runner.cjs` | `src/engine/runner.js` | 音源脚本隔离子进程，仅由 `sandbox.ts` spawn，随包发布 |

---

## 2. 建议的阅读顺序

1. `src/shared/types.ts` —— 先弄清 `MusicInfo` / `PlayerState` / `PluginSettings` / `Provider` 这些名词。
2. `src/index.ts` —— `Config` 与 `apply()`：插件到底注册了什么。
3. `src/playback.ts` —— `PlaybackService`：所有状态变更的唯一入口。
4. `src/provider.ts` + `src/engine/musicEngine.ts` —— 搜索/直链从哪来。
5. `src/tools.ts` —— LLM 能做什么。
6. `src/client.ts` → `src/ui/store.ts` → 各 `*.tsx` —— 浏览器侧。
7. 只在需要时再读 `src/taste/**`（实验性画像，默认关闭）与 `src/engine/runner.js`（隔离子进程）。

---

## 3. 文件职责表

### 3.1 host 侧（Node）

| 文件 | 职责 |
|---|---|
| `src/index.ts` | host 入口。`Config`（schemastery）/ `inject` / `apply()`：装配 storage domain、`PlaybackService`、工具集、画像、自带 skill、卸载清理。 |
| `src/playback.ts` | `PlaybackService`（Typert Remote `lxPlayback`）。播放权威状态、播放列表、播放模式、音质选择、直链缓存、搜索编排。**LLM 工具与 UI 都通过它改状态**。 |
| `src/tools.ts` | LLM 工具集：`music_search` / `music_play` / `music_playlist` / `music_prev` / `music_next` / `music_control` + 兼容入口 `search_and_play`。含防刷限流与点歌日志。 |
| `src/provider.ts` | `Provider` 门面与 `createProvider()`：`engine`（默认）/ `lxserver` / `mock` / `auto` 四种数据源。 |
| `src/lxclient.ts` | lxserver HTTP 客户端（可选路径；超时 10s / 重试 2 次；含 `getLyric`）。 |
| `src/mock.ts` | 内置演示数据源（仅 `providerMode: mock`；含带逐字轴的演示歌词）。 |
| `src/ratelimit.ts` | 滑动窗口限流器（LLM 点歌防刷）。 |
| `src/status.ts` | 自诊断文件 `$DSH_HOME/lx-music-plugin-status.json` 与 `PLUGIN_VERSION`。 |

### 3.2 内置引擎与 SDK

| 文件 | 职责 |
|---|---|
| `src/engine/sandbox.ts` | 沙箱宿主：spawn 子进程、IPC 协议、初始化/调用超时杀进程、请求日志。 |
| `src/engine/runner.js` | **子进程侧**：执行第三方音源脚本（lx 协议）、SSRF 网络策略、日志转发。CJS、自包含，经 rollup 打成 `lib/runner.cjs`。 |
| `src/engine/musicEngine.ts` | `EngineProvider`：脚本轮询/降级、搜索、直链解析、音源增删启停排序。 |
| `src/engine/sourceStore.ts` | 音源脚本持久化，三种后端：`domain`（storage）/ `file`（兜底）/ `memory`（不落盘）。 |
| `src/sdk/index.ts` | 五平台搜索门面：`searchWithPriority()` + 结果规范化（`jsonSafe` 清洗）。 |
| `src/sdk/request.ts` | `httpFetch`（`node:http/https` 实现，含超时与取消）。 |
| `src/sdk/utils.ts` | SDK 共用工具：`decodeName` / `formatPlayTime` / `sizeFormate` / `toMD5` / `formatSingerName`。 |
| `src/sdk/musicSearch.d.ts` | 各平台搜索模块的**唯一**类型声明（见 §5「看起来像 bug 但不是」）。 |
| `src/sdk/{kw,wy,kg,tx,mg}/musicSearch.js` | 各平台搜索实现（移植，Apache-2.0）。 |
| `src/sdk/lyric.ts` | 五平台**歌词**门面：`MusicInfo → 平台入参` 的字段搬运 + 平台分发（`fetchPlatformLyric`）、音源脚本返回值归一（`scriptLyricToPayload`）。 |
| `src/sdk/{kw,wy,kg,tx,mg}/lyric.js` | 各平台歌词实现（移植，Apache-2.0）：kw/wy/kg 带逐字时间轴，tx/mg 只有整行。**导入路径是 `'../request'`（只上一层）**，容易照抄 `wy/utils` 的两层写法写错。 |
| `src/sdk/lyricTypes.d.ts` | 各平台歌词模块的**唯一**类型声明（五个 `lyric.d.ts` 只做转发）。 |
| `src/sdk/kw/util.search.ts` | kw 搜索用到的 `formatSinger` 子集（上游 `kw/util.js` 依赖仓库里不存在的 `@common/*` 别名，故裁出这一份）。 |
| `src/sdk/wy/utils/*`、`src/sdk/tx/utils/*` | 各平台加密/请求封装（移植）。 |

### 3.2.1 歌词解析（shared）

| 文件 | 职责 |
|---|---|
| `src/shared/lrc.ts` | **纯函数**：LRC / LXLR C → `LyricDoc`（行、翻译对齐、逐字轴合理性校验、offset、纯文本补伪时间轴），以及 `findLyricLineIndex` / `findLyricWordIndex` 两个查表函数。host 解析一次，client 只渲染。 |

### 3.3 存储与画像

| 文件 | 职责 |
|---|---|
| `src/storage/keys.ts` | 存储键 → 文件名安全映射（**所有键都必须过 `storageKey()`**）。 |
| `src/storage/migrate.ts` | 旧 `single` 布局 → `per-record` 布局的一次性迁移（搁置旧文件 → 迁移 → 失败可回滚）。 |
| `src/storage/cleanup.ts` | 卸载清理（默认关闭；开启后延迟 + 期间重新激活即取消）。 |
| `src/taste/config.ts` | 画像配置：持久层松散 schema + 读侧归一化。 |
| `src/taste/schema.ts` | 画像各表的持久层 schema。 |
| `src/taste/events.ts` | L0 事件层：事件种类、信号权重、播放终态结算（纯函数）。 |
| `src/taste/profile.ts` | L1 统计画像：增量聚合 + 指数时间衰减 + 置信度门控（纯函数）。 |
| `src/taste/store.ts` | 画像持久化 + 聚合（**唯一存储接触点**）与排行榜/探索池。 |
| `src/taste/normalize.ts` | 实体归一化、版本识别（原唱/Live/翻唱）、严格匹配。 |
| `src/taste/explore.ts` | 探索候选（"没听过但在口味范围内"）。 |
| `src/taste/recorder.ts` | 播放捕获：会话生命周期与结算。 |
| `src/taste/facade.ts` | `TasteFacade`：捕获钩子 + UI/Remote 读写（开关门控在这里）。 |
| `src/taste/tools.ts` | 画像工具：`music_profile` / `music_play_song` / `music_taste`。 |
| `src/taste/skill.ts` | 随插件注册的 `taste-aware-picking` skill 正文。 |
| `src/taste/origin.ts` | 播放来源（user/ai/playlist）的环境传递（不进 wire 契约）。 |

### 3.4 client 侧（浏览器）

| 文件 | 职责 |
|---|---|
| `src/client.ts` | client 入口：`$mount` remote、注入 CSS/词典、注册 `sidebar.footer.action` 卡片与窗口宿主。 |
| `src/ui/store.ts` | `LxStore`：状态快照 + 轮询 host + HTML5 Audio 播放引擎 + Settings/Taste 动作。 |
| `src/ui/remoteContribution.ts` | `lxPlayback` 的 Typert client 面（strict codec 双契约）。 |
| `src/ui/Modal.tsx` | 可拖动/可调大小/记忆位置的模态窗口（各窗口共用）。 |
| `src/ui/Card.tsx` | 侧边栏迷你播放卡片。 |
| `src/ui/WindowsHost.tsx` | 主窗口 / 设置窗口 / 「我的口味」窗口的挂载点。 |
| `src/ui/MainWindow.tsx` | 搜索 + 播放列表管理。 |
| `src/ui/SettingsWindow.tsx` | 音源管理 + 音质策略 + 自动拉取 + 实验性开关。 |
| `src/ui/TasteWindow.tsx` | 「我的口味」：首启引导 + 画像管理。 |
| `src/ui/playModes.ts` | 播放模式的 UI 元数据（图标/文案/循环顺序）。 |
| `src/ui/mediaSession.ts` | **系统媒体控件（SMTC / 媒体键）桥**：把 PlayerState 翻成 `navigator.mediaSession` 的 metadata/playbackState/position/action handler；不支持的调用逐个降级；封面按平台 URL 规律派生多尺寸（`coverArtwork`）。 |
| `src/ui/LyricsWindow.tsx` | 滚动歌词窗口：当前行高亮并自动居中、逐字（卡拉OK）高亮、翻译/音译、点击跳转、字号与"回到当前"，底部显示 SMTC 自检状态。 |
| `src/ui/styles.ts` | 全部 CSS（类名前缀 `lxm-`，注入 `<style>`）。 |

---

## 4. 四条主数据流

**① 搜索**
`LLM 工具 / UI` → `PlaybackService.search()` → `Provider.search()` → `EngineProvider`
→ `sdk.searchWithPriority()` → 各平台 `musicSearch.js` → 规范化为 `MusicInfo[]`。
失败平台记进 `SearchOutcome.attempts`，**不抛错**（首个有结果的平台胜出）。

**② 直链解析**
`PlaybackService.resolveUrl()` → `Provider.resolveUrl()` → `EngineProvider`（按平台挑已启用脚本、轮询、失败降级）
→ `sandbox.ts` spawn 子进程 → `runner.js` 执行第三方脚本 → 直链 URL。
结果进 `PlaybackService` 的 5 分钟缓存（`URL_CACHE_TTL_MS`，上限 200 条）。**直链 100% 依赖音源脚本**。

**③ 播放状态同步（host 是权威）**
host `PlaybackService` 持权威状态 → client 每 500ms 轮询 `getState()` 并按 `version` diff
→ 应用到 HTML5 Audio；进度按 1s 节流上报 `reportProgress()`。
**不要在 client 侧"顺手"改本地状态**，否则会和 host 分叉。

**④ 持久化**
storage domain（`per-record`）→ `$DSH_HOME/storages/lx_music/`；表键一律过 `storageKey()`。
storage 不可用时降级为内存 + 音源文件兜底，并在启动日志与 stderr 明确告警。
写进本机的东西只有哪些，见 [internals.md §4](internals.md)。

**⑤ 歌词（1.3.0）**
`client LyricsWindow` → `remote.getLyric({music})` → `PlaybackService.getLyric()`（6h 缓存，键 `平台|id`）
→ `Provider.getLyric()` → 音源脚本 `lyric` action（仅当脚本声明了该 action）**或** `sdk.fetchPlatformLyric()`
→ `shared/lrc.ts` 的 `parseLyric()` → `LyricDoc` 回给 client。
**拿不到歌词不抛错**：返回带 `note` 的空文档，UI 把 `note` 显示成空状态文案（"这首歌没歌词"不是异常）。

**⑥ 系统媒体控件（1.3.0）**
client 侧的 `MediaSessionBridge` 订阅 store → 每次状态变化把曲目/状态/进度推给
`navigator.mediaSession`；系统面板与**硬件媒体键**的动作再经 store 回到 host（`play/pause/prev/next/seek`）。
桥同时把"推了什么"写回 `snapshot.smtc` 供 UI 自检（系统面板没有回读 API）。详见 [internals.md §7](internals.md)。

---

## 5. 不能碰的硬约束（改代码前先看这里）

一条条都有历史事故，**回归锁**在括号里：

1. **`inject` 只列真正必需的服务**（host 目前只有 `['tools']`）。可选能力（`storageDomain`）必须走
   `ctx.inject([...], cb)` 作用域注入 —— 写进必需 `inject` 会让插件**永不激活**，客户端表现为
   `lxPlayback/*` 全 404。（`tests/activation.test.ts`）
2. **`Config` 每个字段都必须"行配置什么都不给"也能过**。不要用 `.required()`；新增配置项要同步进
   `cordis.patch.yml`。1.2.0 就是漏同步导致插件从未被调用。（`tests/activation.test.ts` 里 `Config({})`）
3. **版本号三处必须一致**：`package.json` / `manifest.json` / `src/status.ts` 的 `PLUGIN_VERSION`。
4. **domain 的 schema 必须与代码实际写入的形状逐字段一致**：任一条记录不匹配会让整个 `open()` 失败，
   插件静默降级为内存存储（播放列表/设置/音源都不落盘）。（`tests/domain-spec.test.ts`、`host.integration.test.ts`）
5. **所有存储键都要过 `storageKey()`**：per-record 布局下键会变成文件名，ISO 时间戳键在 Windows 上直接 ENOENT。
   （`tests/storage-keys.test.ts`）
6. **`cleanupOnUninstall` 必须保持 `false`**：cordis 分不清「卸载」与「升级/热重载」，开启会在升级后误删
   `$DSH_HOME/storages/lx_music/`。删除用户数据只能由用户显式发起。
7. **子进程必须注入 `ELECTRON_RUN_AS_NODE=1`**：桌面版 `process.execPath` 是 Electron 主程序，
   否则会再起一个 GUI 实例并以 `code=0` 退出，音源全部校验失败。（`tests/sandbox-env.test.ts`）
8. **client 的 codec 要同时提供 `schema` 与 `create()`**（兼容 0.1.5 / 0.1.7 两代相反契约）。
   （`tests/remote-contribution.test.ts`）
9. **`src/ui/styles.ts` 里 `.lxm-error` 只能有一处定义**：卡片与窗口共用，历史上两条同选择器规则
   按属性互相覆盖，读代码时看不出最终样式。（`tests/ui-styles.test.ts`）
10. **文案/按钮样式约定**：`.lxm-btn` 用 `min-width` 而不是固定 `width`（否则文字按钮会被挤成竖排）；
    `.lxm-card` 必须可被压缩（否则长报错会撑出侧边栏）。（`tests/ui-styles.test.ts`）
11. **歌词只在 host 解析一次**（`src/shared/lrc.ts`）：client 侧不要再写正则解析歌词，否则两端对
    "当前行"的理解会分叉。逐字时间轴必须过 `isValidWordTimeline`（单调不减 + 不越行时长），
    脏数据一律丢掉逐字轴只留文本。（`tests/lrc.test.ts`）
12. **`src/sdk/<平台>/*.js` 的相对导入深度**：这些文件在 `src/sdk/<平台>/` 下一层，导入
    `request`/`utils` 用 `'../request'`、`'../utils'`（`wy/utils/*` 才是两层）。写错不会在
    `tsc` 里报（`.js` 不参与类型检查），但 `npm run build` 与 `tests/lyric-host.test.ts` 会立刻炸。
13. **系统媒体控件必须"始终有 metadata"**：`navigator.mediaSession.metadata` 一旦为空，Chromium 会
    回落到 `document.title`（= `会话名 — DeepSeek Harness`）——这正是要修的 bug。同理
    `setPositionState` 先校验 `duration/position` 再调用，否则它既抛错又会清空 metadata。
    （`tests/media-session.test.ts`）

---

## 6. 我要改 X，该动哪里

| 想做的事 | 动这些地方 |
|---|---|
| 新增/修改 LLM 工具 | `src/tools.ts`（或 `src/taste/tools.ts`）+ `manifest.json` 的 `tools` + 文档 |
| 新增音质 | `src/shared/types.ts` 的 `Quality` **与** `QUALITIES`（UI 与工具枚举自动跟随）+ `src/playback.ts` 的 `QUALITY_RANK` |
| 新增平台 | `src/shared/types.ts` 的 `MusicSource` / `MUSIC_SOURCES` / `DEFAULT_PLATFORM_PRIORITY` / `SOURCE_LABEL` + `src/sdk/<平台>/` + `src/sdk/index.ts` 的 `PLATFORMS` |
| 新增配置项 | `src/index.ts` 的 `Config`（**不要 `.required()`**）+ `cordis.patch.yml` 的同名字段 + `docs/development.md` §7 |
| 新增存储表 | `src/index.ts` 的 `domainSpec` + 对应 schema（画像表在 `src/taste/schema.ts`） |
| 新增 UI 窗口 | `src/ui/` 新组件 + `src/ui/WindowsHost.tsx` + `src/ui/store.ts` 的开关与快照字段 |
| 新增播放模式 | `src/shared/types.ts` 的 `PlayMode` 与 `PLAY_MODE_VALUES` + `src/ui/playModes.ts`（顺序/图标/文案） |
| 调画像算法 | `src/taste/`（纯函数层 `events.ts` / `profile.ts` / `normalize.ts` / `explore.ts` 可直接单测） |
| 新增/修歌词来源 | 平台实现放 `src/sdk/<平台>/lyric.js` + `src/sdk/lyric.ts` 的 `MODULES`；解析规则改 `src/shared/lrc.ts`（**纯函数，先补 `tests/lrc.test.ts`**）；来源顺序在 `src/engine/musicEngine.ts` 的 `getLyric` |
| 改滚动歌词的显示 | `src/ui/LyricsWindow.tsx` + `src/ui/styles.ts` 的 `.lxm-lyric-*`（解析/时间轴不要在 UI 里改，见 §5.11） |
| 改系统媒体控件行为 | `src/ui/mediaSession.ts`（推送与动作）+ `src/ui/store.ts` 的 `play/pause/stop/seekBy`（媒体键语义）；回归锁 `tests/media-session.test.ts` |

---

## 7. 看起来像 bug、但不是（别白改）

- **`src/sdk/tx/musicSearch.js` 的 `then(({ body, meta }) => ...)`**：看着像从 HTTP 响应里取不存在的
  `meta`，其实上一层的 `musicSearch()` 已经把响应解包成 `body.req.data`，而 QQ 搜索的响应用的就是
  `data.body` / `data.meta` 两层。**只是变量同名容易误读**，逻辑是对的。
- **5 个 `src/sdk/<平台>/musicSearch.d.ts` 内容完全相同**：TypeScript 要求声明文件与 `.js` **同目录同名**
  才能配对，所以它们必须存在；内容是转发到唯一一份 `src/sdk/musicSearch.d.ts`，不是重复维护。
- **`src/sdk/kw/util.search.ts` 与上游 `kw/util.js` 的重复**：上游文件 import 了本仓库不存在的
  `@common/*` 别名，裁剪出搜索路径需要的那两个函数是**刻意的**。
- **`src/engine/runner.js` 是 CJS、`src/sdk/**` 是 .js**：前者要在 `vm` 上下文里 `require`，后者是原样移植的
  第三方代码（`eslint.config.js` 对它们单独关掉了一批规则）。不要"顺手"统一成 ESM/TS。
- **`runner.cjs` 单独构建**：它必须自包含，不能被 host bundle 吸收。

---

## 8. 已知缺口与技术债（诚实清单）

这些是**已确认存在、但本次整理未改动**的问题（多数会改变行为或涉及产品决策）。
新开任务前先看这里，避免重复发现：

**画像（实验性功能，默认关闭）**

- `src/taste/events.ts` 的 `qualityTag` / `hourTag` / `moodTag` / `searchMissDelta` / `AI_ARTIST_DISCOUNT`
  **只有自己的测试在调用**，生产路径没有接线 —— "音质画像""时段画像""搜索未命中反馈"目前是半成品。
- `profileCallsPerHour` 与 `semanticProfile` 已进 schema、已归一化、已显示在 UI，但**没有任何消费方**：
  `music_profile` 实际没有调用上限，语义标注层也没有实现。
- `budget: 'off'` 与 UI 文案不符：`BUDGET_PROFILE.off.candidates === 0`，但取值处写的是
  `budget.candidates || 5`，`0 || 5 === 5`，所以"关闭"仍会返回 5 条候选。
- `TasteFacade.action()` 的 `onboard` / `snooze` 分支没有任何 UI/工具入口可达。
- 同一段时长字符串有两个解析器且语义不同：`shared/types.ts` 的 `intervalToSeconds`（宽松，非法返回 `0`）
  与 `taste/normalize.ts` 的 `secondsFromInterval`（严格，非法返回 `undefined`）。换用前务必确认语义。

**结构**

- `src/index.ts` 的 `applyInner` 约 350 行，混合了配置归一化、storage 打开/迁移/重试、画像接线、
  skill 同步与卸载清理。
- `src/ui/store.ts`（708 行）同时是"客户端播放引擎 + 轮询 + Settings 动作 + Taste 动作"，
  且异步动作有三种错误处理约定（写进快照错误 / 静默吞掉 / 直接抛出）。
- `src/ui/SettingsWindow.tsx`（约 426 行）承载 4 个 Tab 的全部逻辑与 8 个局部状态。
- `src/engine/musicEngine.ts` 与 `src/engine/sourceStore.ts` 里仍有若干 `console.*` 直写，
  绕过了 `index.ts` 注入的 logger —— 桌面版（无终端）看不到这些日志。

**测试**

- 内存版 `StorageFace` 假实现在测试里被复制了 6+ 份，且已经开始漂移；改 `StorageFace` 要改多处。
- `tests/sandbox-guard.test.ts` 与 `tests/source-store.test.ts` 直接 import `node:test` 而没走
  `tests/mini.ts`，因此绕过后者安装的 `DSH_HOME` 隔离。

---

## 9. 一次改动的最小验证

```bash
npm run typecheck && npm run lint && npm test
# 或一条命令：npm run verify
```

发布前还要过 [versioning.md §4](versioning.md) 的清单（版本号三处一致、`cordis.patch.yml` 能通过
`Config` 校验、`inject` 只含必需服务、`npm run release:check`）。
