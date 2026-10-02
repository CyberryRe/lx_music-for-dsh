# lx-music-for-dsh

LX Music 增强控制插件 —— 为 [deepseek_harness](https://github.com/deepseek-ai/deepseek-harness)
提供侧边栏播放卡片、播放/音源管理界面与 LLM 点歌能力。**开箱即用，不需要任何外部服务。**

## 功能

- **侧边栏迷你播放卡片**（位于「设置」按钮上方）：封面、歌名-歌手、可拖动/点击跳转的进度条、
  上一首/播放暂停/下一首、播放模式切换（列表循环/单曲循环/随机/顺序，点击循环切换）、
  播放列表弹窗、设置齿轮。
- **主窗口**（点击卡片主体打开，可调大小、记忆位置）：搜索（关键词/歌手/平台过滤）、
  搜索结果（音质/时长、+队尾 / +下一首）、播放列表管理（拖拽排序、删除、清空、导出文本）。
- **设置窗口**（点击齿轮）：音源管理（文件/URL/粘贴导入并自动启用、启停/删除/排序）、
  音质策略（默认音质、平台优先级）、自动拉取规则（切歌自动最高音质、降级策略）。
- **细粒度 LLM 音乐工具集**：`music_search` / `music_play` / `music_playlist` /
  `music_prev` / `music_next` / `music_control`，以及兼容入口 `search_and_play`；
  内置滑动窗口防刷（默认 6 次/分钟）。
- **音乐画像（实验性 · 默认关闭）**：`music_profile` 读口味画像与"可直取"的曲目候选；
  `music_play_song` **精确点播**一首确定的歌（优先用画像里已确认的平台 id 零搜索播放，
  退化到按曲名+艺人严格确认，确认不到就明确失败——不会拿翻唱或别的版本顶替）；
  `music_taste` 读写口味（`like`/`dislike`/`forget`/`note`/`summary`）。
  另随插件注册 skill `taste-aware-picking`，把"先查画像 → 挑一首确定的歌 → 精确播放"流程版本化。

  > ⚠️ **实验性功能，默认关闭**：开启入口在 设置 →「实验性」页 → 红色警示 →
  「了解风险并开启…」→ 确认框。**未开启时**：不采集任何收听行为、不写点歌日志、不注册 skill、
  卡片上不显示 ♪ 入口。数据全部在本机处理、不上传；本插件**不会**在卸载/升级时自动删除数据，
  需要清理时用「设置 → 实验性 → 清理本机数据」（详见 [技术说明](docs/internals.md) §4）。

## 快速开始

**方式一：npm（推荐）**

```bash
npm i lx-music-for-dsh@latest
dsh plugin --profile <你的profile> add lx-music-for-dsh@latest
```

**方式二：下载 Release 里的预构建包（离线可用，不需要构建、不需要 allowBuilds）**

从 [Releases](https://github.com/CyberryRe/lx-music-for-dsh/releases) 下载
`lx-music-for-dsh-<版本>.tgz`，然后：

```bash
dsh plugin --profile <你的profile> add <下载下来的 .tgz 完整路径>
```

装好后 **彻底退出并重启 DSH**（关窗口不算）——本版本修改插件代码后必须完全重启才会加载新代码，
插件页/卡片会一直显示上一次启动时的旧状态。**这是已知问题，会在下个大版本修复。**

确认是否生效：看 `$DSH_HOME/lx-music-plugin-status.json`（存在即说明 host 半边被调用过，
里面按阶段记录了 storage 是否就绪、**音源落盘后端**（`sourceStore: domain|file`）、注册了几个工具）。
`sourceStore` 必须是 `domain` —— 若是 `file`，说明音源只写进了兜底文件
`$DSH_HOME/storages/lx-music-sources.json`。排查步骤见
[技术说明 §5.2](docs/internals.md#52-插件没生效装了没反应--插件页显示异常)。

## DSH 版本兼容性对照表

| 插件版本 | 目标 DSH | 状态 |
|---|---|---|
| **1.2.3** | **0.2.0** | **推荐**（npm `latest` / `lts`）。修：① 音源持久化（迟到就绪的 storage 现在会重建 provider，音源真正写进 storage domain）；② 切歌竞态（旧歌直链不再被贴到新歌上）；③ 不再在升级/卸载时删除本机数据。**也兼容 0.1.7 / 0.1.5** |
| 1.2.2 | 0.2.0 | ⚠️ 不建议再用：导入的音源只写进兜底文件、重启后可能"消失"；升级插件可能清空本机数据 |
| **1.1.0** | **0.1.7** | 仍在 0.1.x 的用户用它（也兼容 0.1.5）。⚠️ **0.2.0 及以上无法激活**（插件不工作）；能升级 DSH 就换 1.2.3 |
| 1.0.x | **0.1.7 之前** | 历史版本。（例外：**1.0.2** 只配 0.1.7 及以后；**1.0.1** 只配 0.1.5 及更早） |

**怎么选**：DSH **0.2.0+** → 1.2.3｜DSH **0.1.7** → 1.1.0（或直接升 1.2.3）｜DSH **≤ 0.1.5** → 1.0.1。

- 全部已发布版本、每个版本的可用性说明、发布流程与 dist-tag 规则：
  [docs/versioning.md](docs/versioning.md)。
- 升级到 1.2.3 **不需要动 DSH 版本**；存储布局迁移自动完成（旧 `lx_music.json` 会改名为
  `lx_music.json.migrated-<时间戳>` 保留，可随时回退）。
- **1.2.2 → 1.2.3 的一个手工动作**：若你在 profile 的 `cordis.patch.yml` 里手写过
  `cleanupOnUninstall: true`，请改成 `false`（或删掉该行用默认值）——1.2.2 的随包 patch
  把它设成了 `true`，会让每次升级/热重载在 8 秒后删掉
  `$DSH_HOME/storages/lx_music/`（播放列表、设置与音源一起没了）。

## 文档

| 文档 | 内容 |
|---|---|
| [技术说明](docs/internals.md) | 架构、音源脚本沙箱与安全模型、Electron 宿主、codec 双契约、存储与本地数据、排查手册 |
| [版本台账](docs/versioning.md) | 插件 × DSH 对照、每次 DSH 跳跃的断裂点、发布流程与 dist-tag 规则 |
| [开发文档](docs/development.md) | 本地构建/调试/打包/测试、按 DSH 版本安装、验收清单 |
| [画像设计](docs/design-taste-memory.md) | 音乐画像的算法设计与验证结论 |
