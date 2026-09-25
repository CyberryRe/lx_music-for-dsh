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
│   └── link-dsh.mjs         # 镜像 DSH 运行时（显式来源/本地/全局）+ 桌面版版本漂移比对
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
# 说明：@deepseek-ai/* 运行时包从已安装的 DSH 依赖树镜像到本地 node_modules，
# 保证开发/测试与 DSH 运行时版本一致（当前：@deepseek-ai/dsh@0.1.7-rc.2）。
# 来源优先级：--from <dir> / $DSH_RUNTIME_DIR → 项目内 node_modules/@deepseek-ai/dsh
# → 全局 npm 安装树；脚本按版本号比对，镜像过期的包自动重拷、来源已不再提供的包自动
# 清理（--no-prune 关闭；--force 强制重镜像 @deepseek-ai/*）。
#
# 版本漂移防护：脚本还会从桌面版的 resources/app.asar 读出实际运行的 DSH 版本并与镜像
# 来源比对 —— 二者不一致就**拒绝执行**（--allow-drift 跳过），因为镜像会覆盖/清理
# @deepseek-ai/*，用错版本等于把开发树静默换成另一套 API 表面。桌面版 asar 里只有运行时
# JS（.d.ts 已剥离），无法用于类型检查，因此**镜像来源必须是 npm 发布的依赖树**；
# asar 只作为"应用实际跑的是哪个版本"的裁判。桌面版装在非默认目录时用
# `--asar <path>` 或 $DSH_DESKTOP_ASAR 指定。
```

要求：Node ≥ 20（测试建议 Node 24，`node --test` 支持 `--test-isolation`）。
端到端浏览器验证需要本机装 Chrome 或 Edge（`scripts/browser-smoke.mjs` 通过 CDP 驱动，
不需要 puppeteer 下载浏览器）。

## 3. 常用命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 构建 `lib/index.js`（host）与 `lib/client.js`（client bundle） |
| `npm run setup` | 镜像 DSH 运行时（见 §2；`--from/--force/--allow-drift/--full` 见 `node scripts/link-dsh.mjs --help`） |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run lint` | ESLint（0 警告阈值） |
| `npm test` | 编译并运行全部单元测试（131 例） |
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

> 适用 **@deepseek-ai/dsh ≥ 0.1.7-rc.2**。该版本起插件包用 `dsh.bundle.patch` 声明自己是
> 一个 profile 组合层，`dsh plugin add` 会自动激活，**不再需要手工编辑 profile 的
> cordis.patch.yml**（0.1.0-rc.6 时代的手工行在本版本会导致
> `duplicate loader entry id: lx-music`，dsh 直接拒绝启动）。
>
> **0.1.5 及更早不要安装 1.0.2**：0.1.7 移除了 Typert strict codec 的 `schema` 字段
> （改为 `create()`），1.0.2 的 client 面按新契约书写，旧 DSH 会在 `$mount` 抛
> `strict codec has no create() factory`。反之 1.0.1 的 bundle 在 0.1.7 上同样无法激活。

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
dsh plugin --profile web add D:\deepseek_harness\lx_plugin\dist\lx-music-for-dsh-1.0.2.tgz
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

### 6.4 从 GitHub 安装：用 Release asset，不要用 git 依赖

**推荐做法**——直接装 tag 上附带的预构建 tarball（不需要任何构建，也不需要 `allowBuilds`）：

```bash
pnpm add https://github.com/CyberryRe/lx_music-for-dsh/releases/download/v1.0.2/lx-music-for-dsh-1.0.2.tgz
```

桌面版插件管理器的「从 URL 安装」也可以直接填上面这个 URL。实测：`pnpm install` 11 秒装好、
`lib/` 齐全、`client.js` 与 npm 上那份 md5 一致（`83C7AA76C7EB`），全程未触发任何构建脚本。

**为什么 `pnpm add github:CyberryRe/lx_music-for-dsh#v1.0.2` 走不通**

pnpm ≥ 10.26 出于供应链安全默认禁止 git 依赖执行 `prepare` 脚本（
[pnpm 10.26 发布说明](https://pnpm.io/blog/releases/10.26)），而本仓库的 `lib/`
被 `.gitignore` 排除，必须现场构建，于是有两道独立的坎：

1. **放行 key 必须精确到 commit + 抓取 URL，且形式不稳定。**
   实测 `allowBuilds: { lx-music-for-dsh: true }`（只写包名）**无效**，仍报
   `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；必须粘贴 pnpm 报错里打印的那一行。而那一行会
   随 pnpm 实际抓取方式变化：

   | 依赖写法 | pnpm 要求放进 allowBuilds 的 key |
   |---|---|
   | `github:CyberryRe/lx_music-for-dsh#v1.0.2` | `lx-music-for-dsh@git+https://github.com/CyberryRe/lx_music-for-dsh.git#<sha>` |
   | 放行后再装（改为抓 codeload tarball） | `lx-music-for-dsh@https://codeload.github.com/CyberryRe/lx_music-for-dsh/tar.gz/<sha>` |

   即每发一个新版本、用户都要重新改一次 profile 的 `pnpm-workspace.yaml`，不具可用性
   （pnpm 侧相关问题：[#12367](https://github.com/pnpm/pnpm/issues/12367)、
   [#13429](https://github.com/pnpm/pnpm/issues/13429)）。

2. **即便放行，干净检出也构建不出来。** `node scripts/build.mjs` 需要 `@deepseek-ai/*`
   的类型声明来通过 `@rollup/plugin-typescript` 的类型检查，而本仓库刻意不把它们声明为依赖
   （开发时由 `scripts/link-dsh.mjs` 从本机已装的 DSH 镜像）。在只有源码的克隆里会得到
   `TS2307: Cannot find module '@deepseek-ai/dsh-typert-protocol'` 等 6 处错误并级联出
   `TS7006`，构建直接失败。

> 如果将来确实要让 git 依赖可用，需要：把 `@deepseek-ai/dsh` 声明为 `devDependencies`
> （让干净检出能构建，代价是 lockfile 增加约 500 个包），并接受上面「每 commit 一条
> allowBuilds」的配置负担。当前结论是**不值得**，用 Release asset 即可。

> **发版时别忘了传 asset**：每次发布（`npm publish`）之后，把同一个 tarball 作为 asset 传到
> 对应 tag 的 Release 上，否则上面的 URL 会 404：
>
> ```bash
> npm run pack                                   # → dist/lx-music-for-dsh-<版本>.tgz
> gh release upload v<版本> dist/lx-music-for-dsh-<版本>.tgz   # 需要 gh CLI
> ```
>
> 本仓库第 1 步已验证：`dist/` 里的 tarball 与 npm 上那份字节一致
> （`sha1 6cba1b82a96f480cceb4d293c775d8d74ef8eede`），所以传同一个文件即可。

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
#   remote-contribution  client 面契约：每个 strict codec 都提供 0.1.7 要求的 create()
#                 且不再暴露 schema、create() 可解析且记忆化、descriptor 通过 wire 层
#                 校验规则、与 PlaybackService 的 @Remote 方法双向一致（方法名 + 形参个数）
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
- [ ] `npm test` 全部通过（131 例，运行在镜像的 0.1.7-rc.2 运行时上）
- [ ] `node scripts/link-dsh.mjs` 报出「与桌面版一致：0.1.7-rc.2」（不一致会拒绝执行，`--allow-drift` 可跳过）
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
| 1.0.2 | `@deepseek-ai/dsh@0.1.7-rc.2` | **client 面契约适配**：Typert strict codec 的 `schema` → `create()`；descriptor 类型改绑 DSH 真实协议类型；`link-dsh.mjs` 支持显式来源 + 桌面版版本漂移比对 |
| 1.0.1 | `@deepseek-ai/dsh@0.1.5-rc.1`（随包依赖 `*-0.1.5-rc.2`） | 声明 `dsh.bundle.patch`，`dsh plugin add` 一条命令激活；`dsh.client.inject` 修正为现存包；client externals 对齐 0.1.5 基线模块表；**修复 storage domain schema 导致的持久化静默失效** |
| 1.0.0 | `@deepseek-ai/dsh@0.1.0-rc.6` | 需要手工在 profile `cordis.patch.yml` 里 insert 插件行 |

### 10.1 升级到 1.0.2：client 面的 strict codec 契约变了

**先升 DSH 再升插件**（0.1.5 及更早不要装 1.0.2，反之 1.0.1 在 0.1.7 上也起不来）。

0.1.7 的 Typert 协议把 strict codec 从 `{ mode, typeSymbol, schema }` 改成
`{ mode, typeSymbol, create(): TypertSchema }`：

| 位置 | 0.1.5 | 0.1.7 |
|---|---|---|
| 消费 codec | `codec.schema.parse(value)` | `codec.create().parse(value)` |
| 校验 codec | `typeof codec.schema.parse === 'function'` | `typeof codec.create === 'function'` |
| 类型定义 | `readonly schema: TypertSchema` | `readonly create: () => TypertSchema`（`schema` 已移除） |

失败模式很隐蔽：`ctx.remote.$mount(LXP_REMOTE_CONTRIBUTION)` 在 **client 侧**
`typert.remotes.register` 的 `validateCodec` 抛 `strict codec has no create() factory`，
`apply` 中止 → 该 client 行未激活 → DSH shell 直接以
`web boot: N entries did not activate` 失败（或侧边栏卡片不出现）。**host 端完全正常**，
所以只看 host 日志会误判为"插件没问题"。

1.0.2 的三处改动：

1. `src/ui/remoteContribution.ts` 用 `strictCodec()` 工厂产出 `create()`（惰性 + 记忆化，
   schema 只在首次边界使用时物化 —— 协议要求 schema 来自 bundle 自己的 zod realm）；
2. 同一个文件的 descriptor 类型改为 **直接引用 DSH 真实协议类型**
   （`import type { InvocationDescriptor, TypertCodec, … } from '@deepseek-ai/dsh-typert-protocol'`）。
   该 `import type` 会被完全擦除（构建产物里只剩注释），因此不会进 client bundle、也不需要
   写进 `dsh.client.external`；但形状漂移从此会在 `tsc` 阶段报错，而不是等到浏览器里 `$mount` 失败；
3. `tests/remote-contribution.test.ts` 锁定 codec 契约，并交叉校验 client 面与
   `PlaybackService` 的 `@Remote` 方法**双向一致**（方法名集合 + 形参个数），
   避免以后加 `@Remote` 方法忘了同步 client 面（wire 会以 `rejected <param>` / 找不到端点失败）。

### 10.2 升级到 1.0.1 必须处理的两件事

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

### 10.3 回归覆盖

| 测试 | 锁定的行为 |
|---|---|
| `tests/remote-contribution.test.ts` | strict codec 必须提供 `create()`（且不暴露 `schema`）、`create()` 产出可 `parse` 且记忆化、descriptor 通过 wire 校验规则、client 面与 `@Remote` 方法双向一致 |
| `tests/source-store.test.ts` → `DomainSourceStore` 用例 | 旧文件存储一次性合并（采纳缺失/更新的记录、保留 domain 新版本、顺序、改名标记、不传 `legacyFile` 时不合并） |
| `tests/host.integration.test.ts` → `storage domain schema 与写入形状一致` | `source_order` 记录是裸 `string[]`（对象形状必须被拒）、`global` 保留 `playMode`、`sources` 记录字段 |
| `scripts/browser-smoke.mjs` | GUI 能启动（任一 client 行未激活即整体失败）、卡片出现、主窗口打开、`setPlayMode` 参数化 Remote 往返、设置窗口加载音源列表 |
