# lx-music-for-dsh

LX Music 增强控制插件 —— 为 [deepseek_harness](https://github.com/deepseek-ai/deepseek-harness)
Web 模式提供 LX Music 播放控制界面与 LLM 点歌能力。

## 功能

- **侧边栏迷你播放卡片**（位于「设置」按钮上方）：封面缩略图、歌名-歌手、可拖动/点击跳转的
  进度条（与播放器双向同步）、上一首/播放暂停/下一首、播放模式切换按钮（列表循环/单曲循环/
  随机/顺序，点击循环切换）、播放列表弹窗（内含四模式直接选择）、设置齿轮。
- **主窗口**（点击卡片主体打开，可调大小、记忆位置）：搜索（关键词/歌手/平台过滤）、
  搜索结果（音质标识、时长、+队尾 / +下一首）、播放列表管理（拖拽排序、删除、清空、导出为文本，
  播放模式分段按钮）。
- **播放模式**：列表循环（默认，播完回第一首）/ 单曲循环（播完自动重播）/ 随机播放（不重复当前曲目）/
  顺序播放（播完最后一首停止）；host 侧权威状态，持久化，UI 与 LLM 工具共用。
- **设置窗口**（点击齿轮打开）：音源管理（文件/URL/粘贴导入并自动启用、启用/禁用/删除/排序）、
  音质策略（全局默认音质、每音源平台优先级）、自动拉取规则（切歌自动最高音质、降级策略）。
- **细粒度 LLM 音乐工具集**：`music_search`（搜索）/ `music_play`（播放）/ `music_playlist`
  （播放列表管理）/ `music_prev` / `music_next` / `music_control`（暂停、音量、音质、播放模式等），
  另保留兼容入口 `search_and_play`（一步点歌）；内置滑动窗口防刷（默认 6 次/分钟）与带 action 的操作日志。

> 状态持久化（播放列表/音量/音质/播放模式/点歌日志/音源脚本）走 DSH storage domain
> （`$DSH_HOME/storages/lx_music.json`）；storage domain 不可用时降级为内存 + 音源文件兜底，
> 并在启动日志与 stderr 明确告警。

## 架构

- **完全独立**：搜索由**内置音乐 SDK** 提供（移植自 lx-music-desktop，酷我/酷狗/QQ音乐/网易云/咪咕
  五平台）；直链解析由**内置音源脚本引擎**提供（子进程隔离执行 lx-music-desktop 音源脚本协议，
  与 lx-music-desktop v2.12.2 一致——直链 100% 依赖音源脚本）；播放为浏览器 HTML5 Audio。
  无需任何外部服务即可使用。
- **安全模型**：第三方音源脚本（不可信 JS）在**独立子进程**中执行（每个音源一个子进程），
  宿主 DSH 进程只通过 IPC 与其交换 JSON 消息；子进程环境为白名单（不含任何 DSH 机密）、
  网络请求带 **SSRF 防护**（默认拦截私网/回环/链路本地地址）、初始化/调用超时自动杀进程兜底。
  脚本的任何故障——异常、逃逸尝试（如 `Buffer.constructor('return process')`）、死循环——
  都被限制在子进程内，下一次调用自动重启，宿主进程不受影响。
- host（Node）：`PlaybackService`（Typert Remote `lxPlayback`，播放权威状态 + 播放模式 + storage 持久化）、
  细粒度音乐工具集（`music_search`/`music_play`/`music_playlist`/`music_prev`/`music_next`/`music_control`
  及兼容 `search_and_play`）、内置 SDK 搜索、音源脚本子进程沙箱（导入/启用/排序/删除本地管理）、
  可选 lxserver 客户端（超时 10s / 重试 2 次 / 音质与平台降级链）。
- client（浏览器）：React UI（注入 `sidebar.footer.action` slot）+ HTML5 Audio 播放引擎，
  轮询 host 状态（500ms）diff 应用，进度节流上报（1s）。
- provider 门面（`providerMode`）：`auto`（默认，有地址用 lxserver 否则内置引擎）/ `engine`（强制内置引擎）/
  `lxserver`（连接 lxserver 同步服务器）/ `mock`（内置演示数据，用于无网络演示）。

## 快速开始

```bash
npm install && node scripts/link-dsh.mjs   # 镜像 DSH 运行时（版本不一致会自动刷新）
npm run lint && npm run typecheck && npm run build && npm test
# 可选：真实网络冒烟（五平台搜索）
node scripts/compile-tests.mjs && node scripts/smoke-live.mjs
```

`link-dsh.mjs` 优先用 `--from <dir>` / `$DSH_RUNTIME_DIR` 指定的树，否则用项目内
`node_modules/@deepseek-ai/dsh`、再退回全局 npm 安装；并会读取桌面版 `app.asar` 的版本做
**漂移防护**：镜像来源与桌面版不一致时**直接拒绝执行**（装错版本会静默把开发树换成错误的
API 表面），确认要用就加 `--allow-drift`。桌面版 asar 内只有运行时 JS（`.d.ts` 已剥离），
不能用于类型检查，所以只用于版本比对。

安装到 DSH（要求 `@deepseek-ai/dsh` ≥ 0.1.7-rc.2）：

```bash
node scripts/install-to-dsh.mjs            # 打包 + dsh plugin add + 旧版残留迁移校验
# 然后重启 dsh web 并刷新浏览器
```

插件包用 `dsh.bundle.patch` 声明为 profile 组合层，`dsh plugin add` 会自动激活，
无需手工编辑 profile 的 `cordis.patch.yml`。详见 [docs/development.md](docs/development.md)（§6）。

### 给使用者的两种安装方式

```bash
# 方式一：npm（推荐；latest 与 lts 都指向 1.1.0）
npm i lx-music-for-dsh@1.1.0
dsh plugin --profile web add lx-music-for-dsh@1.1.0

# 方式二：GitHub Release 的预构建包（离线可用，不需要构建脚本、不需要 allowBuilds）
pnpm add https://github.com/CyberryRe/lx_music-for-dsh/releases/download/v1.1.0/lx-music-for-dsh-1.1.0.tgz
```

> ✅ **1.1.0 同时兼容 DSH 0.1.5 与 0.1.7**（client 面同时携带两代 codec 契约），所以默认装最新版即可，
> 不需要再按 DSH 版本挑插件版本。
>
> 旧版本是互斥的，仅作参考：**1.0.2** 只能在 0.1.7 及以后用；**1.0.1** 只能在 0.1.5 及更早用。
> 装错会让 client 插件整体激活失败（`web boot: N entries did not activate`），而 host 端日志看起来完全正常。
>
> 另外**不要**用 `github:CyberryRe/lx_music-for-dsh#v1.1.0` 这种 git 依赖写法：pnpm ≥10.26
> 默认禁止 git 依赖执行 `prepare`，而本仓库的 `lib/` 不在 git 里、必须现场构建。原因见
> [docs/development.md](docs/development.md) §6.4。

端到端验证（真实浏览器，需要本机有 Chrome/Edge）：

```bash
node scripts/browser-smoke.mjs "http://127.0.0.1:3099/?token=<token>"
```

## 直链解析失败排查

解析失败时错误会出现在三个位置：

1. **侧边栏卡片 / 主窗口**：显示聚合后的错误摘要（含每个音源脚本的失败原因）。
2. **浏览器 Console**：`[lx-music] 直链解析失败: ...`，包含完整错误消息与**最近 5 条音源脚本 HTTP 请求**（`状态码:URL(耗时)`）。
3. **宿主进程 stdout**（`dsh web` 所在终端）：每个脚本的完整错误堆栈 + `[lx-music sandbox] 音源脚本请求 HTTP <code>: <url>` 非 2xx 告警。

按状态码判断根因：

- `HTTP 403`：第三方 API 拒绝（IP 封禁 / 风控 / UA 校验）——换网络或换音源。
- `HTTP 503`：第三方 API 不可用（onrender 免费实例休眠、配额耗尽或宕机）——重试或稍后再试；手机端能播多半是**缓存了旧直链**或使用了其他音源。
- `timeout` / `ERR`：网络不可达。
- `HTTP 200` 但仍报错：API 返回结构异常或脚本逻辑问题（可看宿主端脚本堆栈定位到具体行）。

音源健康检查：`node scripts/compile-tests.mjs && node scripts/smoke-source.mjs <音源URL> [平台] [关键词]`

## 文档

- [开发文档（调试/打包/安装/测试/验收）](docs/development.md)

## 目录

```
package.json      npm 包 + dsh.bundle / dsh.client 声明
cordis.patch.yml  组合层 patch（dsh plugin add 后自动生效的插件行）
manifest.json     插件清单（元数据：入口、生命周期、工具、配置项）
src/index.ts      host 入口
src/client.ts     client 入口
src/ui/           React 组件
tests/            单元测试（136 例）
docs/             开发文档 / DSH 与 LX Music 研读笔记
```

## 版本兼容性

| 插件版本 | DSH 版本 | 说明 |
|---|---|---|
| **1.1.0** | **`@deepseek-ai/dsh` 0.1.5 ～ 0.1.7 均可** | **双契约**：client 面同时携带 0.1.5 的 `codec.schema` 与 0.1.7 的 `create()`；并修复桌面版（Electron 宿主）音源校验/导入子进程以 `code=0` 退出 |
| 1.0.2 | 仅 0.1.7 及以后 | strict codec 的 `schema` → `create()`（0.1.5 及更早**不兼容**） |
| 1.0.1 | 仅 0.1.5 及更早 | `dsh.bundle` 组合层，一条命令安装（0.1.7 上**不兼容**） |
| 1.0.0 | `@deepseek-ai/dsh@0.1.0-rc.6` | 需手工写 profile patch 行 |

**从 1.0.x 升级到 1.1.0 不需要动 DSH 版本**，也不必迁移数据（插件配置与
`$DSH_HOME/storages/lx_music.json` 格式都没变）。1.1.0 之后同一条线可以继续服务
0.1.5 与 0.1.7 两代运行时，因此它同时挂在 npm 的 `latest` 与 `lts` 两个 dist-tag 上：

```bash
npm i lx-music-for-dsh@latest   # 或 @lts，两者都是 1.1.0
```

### 为什么之前需要"按 DSH 版本配对安装"

0.1.5 与 0.1.7 的 Typert strict codec 契约正好**相反**（都在"校验字段存在 + 用它 parse"）：

| | 0.1.5 | 0.1.7 |
|---|---|---|
| 校验 | `typeof codec.schema.parse === 'function'` | `typeof codec.create === 'function'` |
| 解码 | `codec.schema.parse(v)` | `codec.create().parse(v)` |

只满足一边的 descriptor 会在 `ctx.remote.$mount()` 抛
`strict codec has no create() factory`（或 0.1.5 侧的 `has no parse() method`），导致整个
client 插件无法激活（GUI 报 `web boot: N entries did not activate`，侧边栏卡片直接不出现），
而 **host 端日志完全正常**，极易误判为"插件没问题"。

1.1.0 的做法是**两个字段同时提供**（双方都只读自己那一个字段，多出来的字段不会被拒绝），
并用 `tests/remote-contribution.test.ts` 逐字复刻**两个版本**的校验+解码路径来锁定。
descriptor 的**类型**直接绑 DSH 真实协议类型（`import type … from '@deepseek-ai/dsh-typert-protocol'`），
协议再漂移会在 `tsc` 阶段暴露。

### 桌面版（Electron 宿主）的沙箱子进程

桌面版里插件跑在 Electron 主进程，`process.execPath` 是 **Electron 主程序**而不是 node。
1.0.x 直接用它 spawn 音源 runner，会再起一个 GUI 实例并因单实例锁立刻以 `code=0` 退出，
表现为「音源 X 子进程在初始化期间退出（code=0）」，音源校验/导入全部失败。
1.1.0 给子进程注入 `ELECTRON_RUN_AS_NODE=1`（DSH 自己起内部 Node 脚本也用这一招），
`tests/sandbox-env.test.ts` 锁定该行为与环境白名单的安全边界。

从 1.0.0 升级到 1.0.1 要处理两件事（第 2 件自动完成）：

1. 删掉 profile `cordis.patch.yml` 里手工 `insert` 的 `id: lx-music` 行
   （或用 `scripts/install-to-dsh.mjs` 自动迁移并备份），否则同一 id 会让 dsh 启动失败
   （`duplicate loader entry id: lx-music`）。
2. 1.0.1 修好了 storage domain 的 schema：1.0.0 里它每次 `open` 都失败，插件静默降级为内存存储
   —— 播放列表/设置/播放模式/日志都不落盘。修好后 domain 里的音源快照会比旧版兜底文件
   `$DSH_HOME/storages/lx-music-sources.json` 更旧，插件会自动做一次非破坏性合并，并把该文件
   改名为 `.migrated-<时间戳>`。

启动日志确认状态：`[lx-music-for-dsh] 插件已加载，provider: engine，storage: durable`
（`storage: memory` 表示持久化不可用）。细节见 [docs/development.md](docs/development.md) §10。
