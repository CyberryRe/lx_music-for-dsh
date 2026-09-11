# 开发文档：lx-music-for-dsh

LX Music 增强控制插件（deepseek_harness / DSH Web 模式内置插件）。
本文档说明：环境准备、调试、打包、安装到 DSH、测试与验收。

---

## 1. 项目结构

```
lx_plugin/
├── manifest.json            # 插件清单（元数据：入口、生命周期、工具、配置项）
├── package.json             # npm 包 + dsh.client 声明（浏览器插件名册）
├── tsconfig.json            # 类型检查配置
├── tsconfig.tests.json      # 测试编译配置（CJS 输出）
├── eslint.config.js         # ESLint flat config
├── scripts/
│   ├── build.mjs            # 构建 host(client) bundle（rollup + TypeScript 插件）
│   ├── compile-tests.mjs    # 测试编译（TypeScript API，输出 .test-dist）
│   ├── smoke-live.mjs       # 可选：真实网络冒烟（五平台 SDK 搜索）
│   ├── install-to-dsh.mjs   # 写入 DSH profile 插件行（幂等）
│   └── link-dsh.mjs         # 从全局 DSH 安装树镜像 @deepseek-ai/* 运行时包
├── src/
│   ├── index.ts             # host 入口：Config / apply / storage domain
│   ├── playback.ts          # PlaybackService（Typert Remote：播放权威状态，含播放模式）
│   ├── tools.ts             # LLM 音乐工具集（music_search/play/playlist/prev/next/control + 兼容 search_and_play）
│   ├── lxclient.ts          # lxserver HTTP 客户端（可选，超时 10s / 重试 2 次）
│   ├── provider.ts          # Provider 门面（engine / lxserver / mock 切换）
│   ├── mock.ts              # 内置 mock 音源（演示/测试）
│   ├── ratelimit.ts         # 滑动窗口限流器
│   ├── engine/              # 内置音源引擎（完全独立）
│   │   ├── sandbox.ts       #   子进程沙箱宿主：spawn runner + IPC 协议 + 超时杀进程兜底
│   │   ├── runner.js        #   子进程（隔离边界）：lx 协议执行、SSRF 网络策略、日志转发
│   │   ├── musicEngine.ts   #   引擎调度（脚本轮询/重试/音源管理）
│   │   └── sourceStore.ts   #   音源脚本本地持久化
│   ├── sdk/                 # 内置音乐 SDK（移植 lx-music-desktop，Apache-2.0）
│   │   ├── index.ts         #   五平台搜索门面 + 结果规范化
│   │   ├── request.ts       #   httpFetch（node:http/https 实现）
│   │   ├── utils.ts         #   格式化/解码工具
│   │   └── {kw,kg,tx,wy,mg}/ #   各平台搜索模块（原样移植 + import 适配）
│   ├── shared/types.ts      # host/client 共享类型与默认设置
│   ├── client.ts            # client 入口：sidebar.footer.action 卡片 + 窗口桥
│   └── ui/                  # React 组件（Card / MainWindow / SettingsWindow / Modal / store / playModes）
├── tests/                   # 单元测试（node:test + mini 断言层）
└── docs/
    └── development.md       # 本文档
```

## 2. 环境准备

```bash
npm install          # 安装 devDependencies（--ignore-scripts 亦可）
npm run setup        # 等价于 node scripts/link-dsh.mjs
# 说明：@deepseek-ai/* 运行时包从全局 DSH 安装树
# （%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules）镜像到本地 node_modules，
# 保证开发/测试与 DSH 运行时版本一致（当前：@deepseek-ai/dsh@0.1.5-rc.1）。
# 脚本会比对版本号：镜像过期的包自动重拷，升级全局 dsh 后重跑本脚本即可。
```

要求：Node ≥ 20（测试建议 Node 24，`node --test` 支持 `--test-isolation`）。
端到端浏览器验证需要本机装 Chrome 或 Edge（`scripts/browser-smoke.mjs` 通过 CDP 驱动，
不需要 puppeteer 下载浏览器）。

## 3. 常用命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 构建 `lib/index.js`（host）与 `lib/client.js`（client bundle） |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run lint` | ESLint（0 警告阈值） |
| `npm test` | 编译并运行全部单元测试（127 例） |
| `npm run pack` | 构建 + `npm pack` 产出可安装 tarball |
| `npm run install:dsh` | 打包 + `dsh plugin add` 安装到 profile（默认 web），含旧版残留迁移与结果校验 |
| `npm run smoke:browser -- <url>` | 真实浏览器端到端验证（GUI 启动 + 卡片 + Remote 往返） |

> 受限环境提示：本仓库的构建（rollup）、测试（node:test 单进程）与 lint 均为纯进程内实现，
> 不依赖子进程 spawn，可在文件沙箱中运行。vitest 因进程池需要 spawn 子进程而未采用；
> 常规环境可直接使用 vitest 运行 `tests/`（断言兼容）。

## 4. 调试

### 4.1 host 侧（服务端）

- 启动行（同时写 `ctx.logger` 与 stdout，启动 dsh 的终端可见）：
  `[lx-music-for-dsh] 插件已加载，provider: engine|lxserver|mock，storage: durable|memory`。
  `storage: memory` 表示 storage domain 打开失败、本次运行不会持久化，同一行附近会有完整原因。
- 插件行配置错误会在启动时以 FAILED fiber 报告（`dsh --profile web --dump-config` 可检查组合配置与行覆盖结果）。
- 若 GUI 打不开，先看启动终端：任一 client 行未激活会让 shell 抛
  `web boot: N entries did not activate`；出现 `duplicate loader entry id` 说明 profile 里
  还有手工插入的同 id 行（见 §10.1）。

### 4.2 client 侧（浏览器）

- 打开 DevTools：`window.__ModuleLoader__` 加载 `lib/client.js`；组件错误、remote 调用错误
  会以 `lxm-error` 条显示在卡片/窗口内。
- 浏览器控制台查看 `[ui-lx-music]` 相关日志（如需要可临时放开 console 过滤）。
- 轮询节奏：状态 500ms、进度上报 1s（`src/ui/store.ts` 的 `POLL_MS` / `REPORT_MS`）。

### 4.3 无 lxserver 环境

插件默认 `providerMode: auto`：未配置 `lxServerUrl` 时自动使用**内置引擎**（engine），
完全独立于 lxserver，不依赖任何外部服务：

- **搜索**：由内置音乐 SDK 提供（酷我/酷狗/QQ音乐/网易云/咪咕五平台实时搜索），无需任何配置，开箱即用（需外网）。
- **直链解析**：100% 依赖第三方音源脚本（与 lx-music-desktop v2.12.2 一致）。
  必须在设置窗口「音源管理」页导入 lx-music-desktop 格式的音源脚本
  （文件/URL/粘贴，导入后自动启用并持久化）；**不导入任何音源脚本时，直链解析会失败**
  （无脚本可轮询），这不是插件缺陷，而是 lx-music-desktop 生态的固有设计。
- **音源脚本隔离**：第三方脚本在**独立子进程**执行（每个音源一个子进程，`lib/runner.cjs`），
  宿主只通过 IPC 交换 JSON；子进程环境白名单注入（不含 DSH 机密）、`lx.request` 默认拦截
  私网/回环/链路本地地址（SSRF 防护）、初始化/调用超时自动终止子进程。脚本的异常、逃逸尝试、
  死循环只影响其子进程，宿主进程不受影响。
- **无网络演示**：如需完全离线体验，显式设 `providerMode: mock`（内置 17 首示例歌曲 +
  SoundHelix 示例音频直链），UI 与 LLM 工具全流程可用。

## 5. 打包

```bash
npm run build
# 产物：
#   lib/index.js    host 插件（ESM，external：@deepseek-ai/*、zod、schemastery；banner 注入 __dirname）
#   lib/runner.cjs  音源脚本隔离子进程（CJS，仅供 sandbox.ts spawn 执行，随包发布）
#   lib/client.js   浏览器 bundle（window.__ModuleLoader__.load 包装，
#                   external = DSH 客户端基线模块表：react/react-dom/cordis/dsh-client-ui-slots/...）
npm run pack        # 生成 lx-music-for-dsh-<version>.tgz
```

## 6. 安装到 DSH（web 模式）

> 适用 **@deepseek-ai/dsh ≥ 0.1.5-rc.1**。该版本起插件包用 `dsh.bundle.patch` 声明自己是
> 一个 profile 组合层，`dsh plugin add` 会自动激活，**不再需要手工编辑 profile 的
> cordis.patch.yml**（0.1.0-rc.6 时代的手工行在本版本会导致
> `duplicate loader entry id: lx-music`，dsh 直接拒绝启动）。

### 6.1 常规安装（一条命令）

```bash
node scripts/install-to-dsh.mjs                 # 默认装到 profile web
node scripts/install-to-dsh.mjs --profile web   # 等价
node scripts/install-to-dsh.mjs --dry-run       # 只看会做什么
```

脚本做四件事：
1. `npm pack` 产出 `dist/lx-music-for-dsh-<version>.tgz`（自带 `cordis.patch.yml`）；
2. **迁移**：若 profile 的 `cordis.patch.yml` 里还有旧版手工 `insert` 的 `id: lx-music` 行，
   自动删除并备份为 `cordis.patch.yml.bak-<时间戳>`（`--no-prune` 只提示不修改）；
3. 安装：若该包已是 profile 依赖则先 `dsh plugin remove` 再 `add`
   —— pnpm 把 `file:` tarball 当不可变依赖，同一版本号重新打包后直接 `add` 会沿用旧副本，
   开发循环会静默装到过期代码（`--force` 不生效）；
4. 校验包是否真的进了 `dsh.profile.bundles`，并提示后续步骤。

也可以手动等价执行：

```bash
npm run pack
dsh plugin --profile web add D:\deepseek_harness\lx_plugin\dist\lx-music-for-dsh-1.0.1.tgz
```

重启 `dsh web`，刷新浏览器：
- 侧边栏底部「设置」按钮上方出现 LX Music 迷你卡片（含播放模式切换按钮）；
- 模型工具列表中应包含细粒度音乐工具集：`music_search` / `music_play` / `music_playlist` /
  `music_prev` / `music_next` / `music_control`（以及兼容入口 `search_and_play`）。

### 6.1.1 配置覆盖

默认配置由包内 `cordis.patch.yml` 提供。要改配置，在 profile 的 `cordis.patch.yml` 里写
**顶层覆盖行**（同 id，整行替换 config，不做深度合并）：

```yaml
- id: lx-music
  config:
    lxServerUrl: ''                        # 可选：lxserver 地址（默认用内置引擎）
    providerMode: 'engine'                 # auto/engine/lxserver/mock
    defaultQuality: '320k'
    qualityFallbackChain: ['flac', '320k', '128k']
    platformPriority: ['wy', 'tx', 'kg', 'kw', 'mg']
    autoPullHighestOnSwitch: true
    fallbackStrategy: 'both'
    rateLimitPerMinute: 6
```

想临时停用插件：`- id: lx-music` + `disabled: true`。
核对最终生效配置：`dsh --profile web --dump-config`。

### 6.2 开发期安装（本地路径）

```bash
dsh plugin --profile web add D:\deepseek_harness\lx_plugin
```
改代码后：`npm run build` → 重启 `dsh web`（host 变更）或仅刷新页面（client bundle 变更，
`rev` 查询参数变化后浏览器会重新拉取 `/plugins/lx-music-for-dsh/client.js`）。

### 6.2.1 端到端验证（真实浏览器）

单元测试覆盖不到"client bundle 是否能在真实 shell 里激活"——DSH 只要有一个 client 行未激活，
整个 GUI 就以 `web boot: N entries did not activate` 失败。用内置的 CDP 冒烟脚本验证：

```bash
# 先起一个测试 profile（不要动正在用的 3080）
dsh --profile lxtest --from-default-profile web --port 3099 --no-open
node scripts/browser-smoke.mjs "http://127.0.0.1:3099/?token=<token>"
# 输出：GUI booted / 卡片存在 / 主窗口打开 / setPlayMode 往返 / 设置窗口，退出码 0 = 通过
```

需要本机有 Chrome 或 Edge（可用 `--chrome <路径>` 指定）。脚本会把它改动的播放模式恢复原值。

### 6.3 数据源模式（providerMode）

| 模式 | 说明 |
|---|---|
| `auto`（默认） | 配置了 `lxServerUrl` 用 lxserver，否则用内置引擎 |
| `engine` | **完全独立**：搜索用内置音乐 SDK（五平台），直链用「音源管理」导入的音源脚本 |
| `lxserver` | 连接 lxserver 同步服务器（搜索/直链/音源管理走其 API），需配置 `lxServerUrl` |
| `mock` | 内置演示数据（17 首示例歌曲，无网络演示） |

音源脚本（.js，lx-music-desktop 格式）在设置窗口「音源管理」页导入（文件/URL/粘贴），
导入后自动启用；脚本与顺序持久化在 `$DSH_HOME/storages`。内置直链与 lx-music-desktop
v2.12.2 保持一致：100% 由音源脚本提供。
## 7. 配置项（Config，schemastery）

| 字段 | 默认 | 说明 |
|---|---|---|
| `lxServerUrl` | `''` | LX Music 服务端地址（仅 lxserver 模式需要） |
| `providerMode` | `'auto'` | auto/engine/lxserver/mock（旧版 `mockMode` 值自动迁移） |
| `defaultQuality` | `'320k'` | 全局默认音质（128k/320k/flac/...） |
| `qualityFallbackChain` | `['flac','320k','128k']` | 音质降级链 |
| `platformPriority` | `['wy','tx','kg','kw','mg']` | 搜索平台优先级 |
| `autoPullHighestOnSwitch` | `true` | 切歌自动拉取最高音质 |
| `fallbackStrategy` | `'both'` | 解析失败降级策略（next-quality/next-platform/both） |
| `rateLimitPerMinute` | `6` | LLM 点歌限流（次/分钟） |

设置窗口的修改会持久化到 `$DSH_HOME/storages/lx_music.json`（storage domain `lx_music`），
优先于行配置。该 domain 的 schema 是**持久层读边界校验**：任一条存储记录不匹配就会让整个
`open` 失败、插件降级为内存存储，因此改动 schema 必须与代码实际写入的形状逐字段对齐
（见 §10.1 与 `tests/host.integration.test.ts`）。

## 8. 测试

```bash
npm test
# 覆盖：
#   ratelimit     滑动窗口限流（允许/拒绝/滑动/重置/边界）
#   lxclient      超时重试、平台优先级搜索编排、直链请求体、音源 CRUD 与自动启用
#   mock          mock 搜索（关键词/歌手/平台/去重/limit）与直链
#   playback      播放控制（含播放模式：列表循环/单曲循环/顺序播放/随机播放）、列表管理（队尾/下一首/删除/清空/拖拽排序/导出）、
#                 设置持久化、音质选择（最高音质/默认/显式/回退）、直链降级
#   tools         细粒度音乐工具集（7 个）：music_search/play/playlist/prev/next/control、
#                 兼容 search_and_play、防刷（超限拒绝/窗口恢复）、点歌日志（action 字段）、输出渲染
#   provider      provider 选择逻辑与 mock 音源管理全流程
#   engine        音源脚本沙箱（加载/调用/超时/错误/工具函数）、引擎调度（轮询/降级/排序）、
#                 音源管理（上传/启停/删除/校验）、本地持久化、SDK 结果规范化、
#                 DomainSourceStore 旧文件存储一次性合并
#   host.integration  apply 全流程（服务注册/工具集注册/搜索→直链→播放/限流）、
#                 storage domain schema 与写入形状一致性
```

可选真实网络冒烟（五平台搜索，需外网）：
```bash
node scripts/compile-tests.mjs && node scripts/smoke-live.mjs
```

`tests/mini.ts` 提供 vitest 兼容的 `describe/it/expect/vi` 子集（node:test 之上），
普通环境若使用 vitest 无需改动测试文件。

## 9. 验收清单

- [ ] `npm run lint` 通过（0 error / 0 warning）
- [ ] `npm run typecheck` 通过
- [ ] `npm run build` 生成 lib/index.js + lib/client.js + lib/runner.cjs
- [ ] `npm test` 全部通过（127 例，运行在镜像的 0.1.5-rc.1 运行时上）
- [ ] `node scripts/install-to-dsh.mjs --profile <p>` 一条命令装好，且包出现在
      profile `package.json` 的 `dsh.profile.bundles` 里（不再需要手工 patch 行）
- [ ] `dsh --profile <p> --dump-config` 中 `lx-music` 行只出现一次，且 profile 覆盖生效
- [ ] 启动日志为 `[lx-music-for-dsh] 插件已加载，provider: …，storage: durable`
      （`storage: memory` 表示持久化不可用，见 §10.1）
- [ ] `node scripts/browser-smoke.mjs <url>` 退出码 0：GUI 启动、卡片出现、
      主窗口打开、`setPlayMode` 往返、设置窗口加载音源列表
- [ ] 安装到 web profile 后侧边栏出现卡片，按钮/进度条实时生效
- [ ] 卡片播放列表弹层与主窗口播放列表页可切换四种播放模式（列表循环/单曲循环/随机/顺序），
      单曲循环播完自动重播、顺序播放到末尾停止、随机播放不重复当前曲目
- [ ] LLM 可调用细粒度音乐工具集（music_search/music_play/music_playlist/music_prev/music_next/music_control，
      含防刷与 action 日志）
- [ ] 无 lxserver 时内置引擎全功能可用（搜索开箱即用；导入音源脚本后直链解析正常）；
      配置 lxserver 后搜索/直链/音源管理走真实服务

## 10. 版本兼容性

| 插件版本 | DSH 版本 | 说明 |
|---|---|---|
| 1.0.1 | `@deepseek-ai/dsh@0.1.5-rc.1`（随包依赖 `*-0.1.5-rc.2`） | 声明 `dsh.bundle.patch`，`dsh plugin add` 一条命令激活；`dsh.client.inject` 修正为现存包；client externals 对齐 0.1.5 基线模块表；**修复 storage domain schema 导致的持久化静默失效** |
| 1.0.0 | `@deepseek-ai/dsh@0.1.0-rc.6` | 需要手工在 profile `cordis.patch.yml` 里 insert 插件行 |

### 10.1 升级到 1.0.1 必须处理的两件事

**1) 删除 profile 里遗留的手工插件行。**
1.0.0 靠手工在 `cordis.patch.yml` 里 `insert` 一条 `id: lx-music`。1.0.1 起该行由包内
`cordis.patch.yml`（`dsh.bundle.patch`）提供；两处同时 insert 会让 cordis 以
`duplicate loader entry id: lx-music` 拒绝启动整个 dsh。
`scripts/install-to-dsh.mjs` 会自动删除该行并备份（`--no-prune` 只提示）。

**2) storage domain schema 修复带来的音源合并（自动）。**
1.0.0 的 `domainSpec.source_order` 声明成对象 `{ order: string[] }`，而
`engine/sourceStore.ts` 往键 `order` 写的是**裸 `string[]`**。storage domain 在 durable
边界校验每条记录，形状不匹配就让整个 `open` 以 `invalid-record` 失败 —— 插件随即静默降级
为内存存储；只有音源脚本靠 `FileSourceStore`（`$DSH_HOME/storages/lx-music-sources.json`）兜底，
**播放列表、音量、音质、播放模式、点歌日志全部不落盘**。

1.0.1 修好了 schema（`source_order` 改为 `z.array(z.string())`，并补上 `global.playMode`）。
副作用是：domain 里的音源快照停留在"storage 最后一次成功打开的会话"，通常比文件存储更旧，
直接切回 domain 会让用户当前在用的音源看起来消失。因此 `DomainSourceStore` 在 storage domain
可用时做一次**非破坏性合并**：

- 只写入 domain 里缺失、或 `updatedAt` 更新的记录（domain 里更新的记录保持不变）；
- 合并后把旧文件改名为 `lx-music-sources.json.migrated-<时间戳>` 作为"已迁移"标记 ——
  否则用户删掉的音源会在下次启动时被旧文件复活。

迁移只在真正的运行入口（`provider.ts` 的 `createProvider`）打开；`EngineProvider` 的默认
构造不迁移，避免测试/嵌入方在用户真实 `$DSH_HOME` 上产生写盘副作用。启动日志会打印：

```
[lx-music-for-dsh] 插件已加载，provider: engine，storage: durable
[lx-music] 已从文件存储合并 1 个音源到 storage domain: 星海音乐源.js
```

`storage: memory` 表示 storage domain 打开失败（状态不会持久化）—— 1.0.1 起这条降级同时写
`ctx.logger` 与 stderr，不再静默；排查时看启动终端的完整错误堆栈。

### 10.2 回归覆盖

| 测试 | 锁定的行为 |
|---|---|
| `tests/source-store.test.ts` → `DomainSourceStore` 用例 | 旧文件存储一次性合并（采纳缺失/更新的记录、保留 domain 新版本、顺序、改名标记、不传 `legacyFile` 时不合并） |
| `tests/host.integration.test.ts` → `storage domain schema 与写入形状一致` | `source_order` 记录是裸 `string[]`（对象形状必须被拒）、`global` 保留 `playMode`、`sources` 记录字段 |
| `scripts/browser-smoke.mjs` | GUI 能启动（任一 client 行未激活即整体失败）、卡片出现、主窗口打开、`setPlayMode` 参数化 Remote 往返、设置窗口加载音源列表 |
