# 技术说明（按用途）

本文件收纳 README 里不适合铺开的技术细节：**架构与安全模型**、**Electron 宿主**、
**codec 双契约**、**存储与本地数据**、**排查手册**、**历史升级坑**。
面向使用者/维护者；开发流程见 [development.md](development.md)，版本关系见 [versioning.md](versioning.md)。

## 1. 架构

- **完全独立**：搜索由**内置音乐 SDK** 提供（移植自 lx-music-desktop，酷我/酷狗/QQ音乐/网易云/咪咕
  五平台）；直链解析由**内置音源脚本引擎**提供（子进程隔离执行 lx-music-desktop 音源脚本协议，
  与 lx-music-desktop v2.12.2 一致——直链 100% 依赖音源脚本）；播放为浏览器 HTML5 Audio。
  无需任何外部服务即可使用。
- **host（Node）**：`PlaybackService`（Typert Remote `lxPlayback`，播放权威状态 + 播放模式 +
  storage 持久化）、细粒度音乐工具集（`music_search`/`music_play`/`music_playlist`/`music_prev`/
  `music_next`/`music_control` 及兼容 `search_and_play`）、内置 SDK 搜索、音源脚本子进程沙箱
  （导入/启用/排序/删除本地管理）、可选 lxserver 客户端（超时 10s / 重试 2 次 / 音质与平台降级链）。
- **client（浏览器）**：React UI（注入 `sidebar.footer.action` slot）+ HTML5 Audio 播放引擎，
  轮询 host 状态（500ms）diff 应用，进度节流上报（1s）。
- **provider 门面**（`providerMode`）：`auto`（默认，有地址用 lxserver 否则内置引擎）/
  `engine`（强制内置引擎）/ `lxserver`（连接 lxserver 同步服务器）/ `mock`（内置演示数据）。

## 2. 安全模型：音源脚本沙箱

第三方音源脚本是**不可信 JS**，因此：

- 在**独立子进程**中执行（每个音源一个子进程），宿主 DSH 进程只通过 IPC 交换 JSON 消息；
- 子进程环境为**白名单**（不含任何 DSH 机密）；
- 网络请求带 **SSRF 防护**（默认拦截私网/回环/链路本地地址）；
- 初始化/调用**超时自动杀进程**兜底。

脚本的任何故障——异常、逃逸尝试（如 `Buffer.constructor('return process')`）、死循环——都被限制在
子进程内，下一次调用自动重启，宿主进程不受影响。回归锁：`tests/sandbox-env.test.ts`（子进程环境）、
`tests/engine.test.ts`（脚本沙箱与调度）。

### 2.1 Electron 宿主（桌面版）的子进程

桌面版里插件跑在 Electron 主进程，`process.execPath` 是 **Electron 主程序**而不是 node。
1.0.x 直接用它 spawn 音源 runner，会再起一个 GUI 实例并因单实例锁立刻以 `code=0` 退出，
表现为「音源 X 子进程在初始化期间退出（code=0）」，音源校验/导入全部失败。

1.1.0 起给子进程注入 `ELECTRON_RUN_AS_NODE=1`（DSH 自己起内部 Node 脚本也用这一招），
`tests/sandbox-env.test.ts` 锁定该行为与环境白名单的安全边界。

## 3. client 面的 codec 双契约（为什么曾经要"按 DSH 版本配对安装"）

0.1.5 与 0.1.7 的 Typert strict codec 契约正好**相反**（都在"校验字段存在 + 用它 parse"）：

| | 0.1.5 | 0.1.7 |
|---|---|---|
| 校验 | `typeof codec.schema.parse === 'function'` | `typeof codec.create === 'function'` |
| 解码 | `codec.schema.parse(v)` | `codec.create().parse(v)` |

只满足一边的 descriptor 会在 `ctx.remote.$mount()` 抛 `strict codec has no create() factory`
（或 0.1.5 侧的 `has no parse() method`），导致整个 client 插件无法激活（GUI 报
`web boot: N entries did not activate`，侧边栏卡片直接不出现），而 **host 端日志完全正常**，
极易误判为"插件没问题"。

1.1.0 起**两个字段同时提供**（双方都只读自己那一个字段，多出来的字段不会被拒绝），
并用 `tests/remote-contribution.test.ts` 逐字复刻**两个版本**的校验+解码路径来锁定。
descriptor 的**类型**直接绑 DSH 真实协议类型（`import type … from '@deepseek-ai/dsh-typert-protocol'`），
协议再漂移会在 `tsc` 阶段暴露。

## 4. 存储与本地数据

状态持久化（播放列表/音量/音质/播放模式/点歌日志/音源脚本/画像）走 DSH storage domain。
1.2.0 起为 **per-record** 布局：`$DSH_HOME/storages/lx_music/` 目录，旧 `lx_music.json` 会在启动时
自动迁移并改名为 `lx_music.json.migrated-<时间戳>`（保留，可回退）。storage domain 不可用时
降级为内存 + 音源文件兜底，并在启动日志与 stderr 明确告警。

**插件写在本机的东西只有**：

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/storages/lx_music/` | per-record 目录：播放列表/设置/画像/点歌日志/音源 |
| `$DSH_HOME/storages/lx_music.json.migrated-*` | 旧版整份文件（迁移时改名保留） |
| `$DSH_HOME/storages/lx-music-sources.json*` | 音源文件兜底（storage 不可用时才写） |
| `$DSH_HOME/lx-music-plugin-status.json` | 插件自诊断（见 §5.2） |

**清理**：

- **卸载插件时自动清理**上述全部内容。清理是**延迟 8 秒 + 可取消**的——DSH 升级插件同样是
  "卸载旧包 → 装新包"，期间只要插件重新激活就取消，避免每次升级都丢播放列表；
  不想要就在行配置里写 `cleanupOnUninstall: false`。
- 随时可在「设置 → 实验性 → 清理本机数据」里点「彻底清除本地数据」（清空播放列表 + 画像 +
  点歌日志，音源脚本保留，需二次确认）。
- 实现与回归锁：`src/storage/cleanup.ts`、`tests/cleanup.test.ts`。

## 5. 排查手册

### 5.1 直链解析失败

错误会出现在三个位置：

1. **侧边栏卡片 / 主窗口**：聚合后的错误摘要（含每个音源脚本的失败原因）。
2. **浏览器 Console**：`[lx-music] 直链解析失败: ...`，包含完整错误消息与**最近 5 条音源脚本
   HTTP 请求**（`状态码:URL(耗时)`）。
3. **宿主进程 stdout**（`dsh web` 所在终端）：每个脚本的完整错误堆栈 +
   `[lx-music sandbox] 音源脚本请求 HTTP <code>: <url>` 非 2xx 告警。

按状态码判断根因：

- `HTTP 403`：第三方 API 拒绝（IP 封禁 / 风控 / UA 校验）——换网络或换音源。
- `HTTP 503`：第三方 API 不可用（免费实例休眠、配额耗尽或宕机）——重试或稍后再试；
  手机端能播多半是**缓存了旧直链**或使用了其他音源。
- `timeout` / `ERR`：网络不可达。
- `HTTP 200` 但仍报错：API 返回结构异常或脚本逻辑问题（可看宿主端脚本堆栈定位到具体行）。

音源健康检查：

```bash
node scripts/compile-tests.mjs && node scripts/smoke-source.mjs <音源URL> [平台] [关键词]
```

### 5.2 插件"没生效"（装了没反应 / 插件页显示异常）

1. **先彻底重启 DSH**（完全退出进程，关窗口不算）。本版本修改插件代码后必须重启才会加载新
   代码，插件页/卡片会一直显示上一次启动时的旧状态——这是已知问题，下个大版本修复。
2. **看自诊断文件** `$DSH_HOME/lx-music-plugin-status.json`：
   - **存在** = host 半边被调用过，里面按阶段记录 `enter → storage-ready → ready`、
     storage 是 `durable` 还是 `memory`、注册了几个工具、迁移结果、失败栈；
   - **不存在** = `apply()` 压根没被调用（loader/依赖/行配置问题），此时客户端表现为
     `lxPlayback/*` 一律 404。
3. **看插件页报错**。三个经典陷阱（细节见 [development.md](development.md) §4.1.1）：
   ① 可选能力写进必需 `inject` → 永不激活；② `Config` 里写了 `.required()` 而行配置没提供 →
   配置校验失败；③ 直接读未声明的服务（`ctx.storageDomain`）→ `cannot get property … without inject`。
4. 启动日志确认状态：`[lx-music-for-dsh] 插件已加载，provider: engine，storage: durable`。

## 6. 历史升级坑

**1.0.0 → 1.0.1** 要处理两件事（第 2 件自动完成）：

1. 删掉 profile `cordis.patch.yml` 里手工 `insert` 的 `id: lx-music` 行
   （或用 `scripts/install-to-dsh.mjs` 自动迁移并备份），否则同一 id 会让 dsh 启动失败
   （`duplicate loader entry id: lx-music`）。
2. 1.0.1 修好了 storage domain 的 schema：1.0.0 里它每次 `open` 都失败，插件静默降级为内存存储
   —— 播放列表/设置/播放模式/日志都不落盘。修好后 domain 里的音源快照会比旧版兜底文件
   `$DSH_HOME/storages/lx-music-sources.json` 更旧，插件会自动做一次非破坏性合并，
   并把该文件改名为 `.migrated-<时间戳>`。

**1.2.0 → 1.2.1/1.2.2**：1.2.0 与 1.2.1 从未发布到 npm；1.2.0 因 `Config` 必需字段从未激活、
1.2.1 因直读 `storageDomain` 在 0.2.0 上不激活，两者都只在开发树里存在。升级到 1.2.2 只需要
**彻底重启 DSH**；存储迁移自动完成。
