# 开发文档：lx-music-for-dsh

LX Music 增强控制插件（deepseek_harness / DSH Web 模式内置插件）。
本文档说明：环境准备、调试、打包、安装到 DSH、测试与验收。

---

## 1. 项目结构

**模块级文件职责表在 [architecture.md §3](architecture.md)** —— 那是唯一维护点。
这里只列顶层布局，避免两处各写一份然后逐渐漂移。

```
lx_plugin/
├── manifest.json            # 插件清单（元数据：入口、生命周期、工具、配置项）
├── cordis.patch.yml         # 行配置模板（安装/升级时写入 profile 的 config）
├── package.json             # npm 包 + dsh.client 声明（浏览器插件名册）
├── tsconfig.json            # 类型检查配置
├── tsconfig.tests.json      # 测试编译配置（CJS 输出）
├── eslint.config.js         # ESLint flat config
├── scripts/                 # 构建 / 测试编译 / 安装到 DSH / 镜像运行时 / 冒烟
├── src/                     # 源码：host 入口 + client UI + 内置引擎 + SDK + 画像
├── tests/                   # 单元测试（node:test + mini 断言层）
└── docs/                    # architecture / internals / development（本文档）/ versioning /
                             # design-taste-memory，另有 research-* / video-script 内部稿
```

> 读代码建议先看 [architecture.md](architecture.md)：完整文件职责表、四条主数据流、
> 「不能碰的硬约束」、「我要改 X 该动哪里」都在那里。

## 2. 环境准备

```bash
npm install          # 安装 devDependencies（--ignore-scripts 亦可）
npm run setup        # 等价于 node scripts/link-dsh.mjs
# 说明：@deepseek-ai/* 运行时包从已安装的 DSH 依赖树镜像到本地 node_modules，
# 保证开发/测试与 DSH 运行时版本一致（当前镜像：@deepseek-ai/dsh@0.1.7-rc.2）。
# 注意：镜像版本 = 本机 DSH 依赖树的版本，与插件「目标 DSH 版本」是两件事
# （1.3.0 目标是 0.2.0，但 0.1.7 → 0.2.0 的运行时包字节相同，断的只是应用层加载时序，
#  详见 docs/versioning.md §2；所以本机镜像停在 0.1.7-rc.2 是预期的）。
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
| `npm test` | 编译并运行全部单元测试（399 例 / 102 套） |
| `npm run verify` | 门禁三连：`typecheck` + `lint` + `test` |
| `npm run pack` | 构建 + `npm pack` 产出可安装 tarball |
| `npm run install:dsh` | 打包 + `dsh plugin add` 安装到 profile（默认 web），含旧版残留迁移与结果校验 |
| `npm run smoke:browser -- <url>` | 真实浏览器端到端验证（GUI 启动 + 卡片 + Remote 往返） |

> 受限环境提示：本仓库的构建（rollup）、测试（node:test 单进程）与 lint 均为纯进程内实现，
> 不依赖子进程 spawn，可在文件沙箱中运行。vitest 因进程池需要 spawn 子进程而未采用；
> 常规环境可直接使用 vitest 运行 `tests/`（断言兼容）。

## 4. 调试

### 4.1 host 侧（服务端）

- **插件到底有没有被激活：先看 `$DSH_HOME/lx-music-plugin-status.json`**（1.2.1 起自动写出）。
  它由 `apply()` 一进入就落盘，不依赖任何服务，桌面版看不到 console 时尤其有用：
  - 文件**不存在** → `apply()` 根本没被调用（loader/依赖/行配置问题，见 §4.1.1），
    此时服务与工具都不存在，客户端表现为 `lxPlayback/*` 一律 404；
  - `history` 里的 `phase` 依次是 `enter → storage-ready → ready`，`storage` 字段给出
    `durable|memory`，`stash`/`migration` 给出迁移细节，`error` 给出失败原因（含栈）。
- 启动行（同时写 `ctx.logger` 与 stdout，启动 dsh 的终端可见）：
  `[lx-music-for-dsh] 插件已加载，provider: engine|lxserver|mock，storage: durable|memory，工具: N`。
  `storage: memory` 表示 storage domain 打开失败、本次运行不会持久化，同一行附近会有完整原因。
- 插件行配置错误会在启动时以 FAILED fiber 报告（`dsh --profile web --dump-config` 可检查组合配置与行覆盖结果）。
- 若 GUI 打不开，先看启动终端：任一 client 行未激活会让 shell 抛
  `web boot: N entries did not activate`；出现 `duplicate loader entry id` 说明 profile 里
  还有手工插入的同 id 行（见 §10.3）。

### 4.1.1 插件"没生效"的两个经典陷阱（1.2.0 实测，各踩一次）

两者的表现完全一样（**服务/工具/存储全部不存在，客户端全 404**），但原因不同：

1. **必需依赖写进了 `inject`**。cordis 的 `inject` 是**必需**依赖：其中任一服务没就绪，
   `apply()` 就永远不被调用。可选能力（本项目里是 `storageDomain`、`skills`）必须走
   **作用域注入** `ctx.inject([...], cb)`，并且代码里的降级分支要与之一致。
   锁：`tests/activation.test.ts` 断言 `inject` 只含 `tools`。
2. **`Config` 里写了 `.required()` 而随包 `cordis.patch.yml` 没提供该字段**。
   schemastery 的 `.required()` 要求**行配置显式提供**（`.default()` 兜不住），
   于是 cordis 在 `resolveConfig` 阶段直接判非法：
   `ValidationError: invalid config: - $.migrateLegacyDomain missing required value`。
   用户自己写 profile patch 时（`- id: lx-music`，patch 是**整行替换、不做深度合并**）
   行配置会整体消失，所以"缺省即可用"是硬要求。
   锁：`Config({})` 必须通过 + 随包 patch 的 config 必须通过校验（同文件）。

3. **直接读未声明的服务**。cordis 4 的 context 代理只允许读「`inject` 已声明」或
   「本 fiber 已 provide」的服务，其它一律抛 `cannot get property "<name>" without inject`。
   所以 `if (ctx.storageDomain)` 这种写法在存储服务没给到这个 fiber 时**直接炸掉整个插件激活**
   （1.2.1 在 DSH 0.2.0-rc.2 上的事故）。可选能力**只能**通过作用域注入拿：

   ```ts
   ctx.inject(['storageDomain'], (scoped) => { const domain = scoped.storageDomain /* ... */ })
   ```

   这与第 1 条是一体两面：写进 `inject`（必需）会在服务缺席时永不激活，直接读（未声明）会在
   服务缺席时抛错——**只有作用域注入**既能等到服务、又能在缺席时降级。
   （实测：DSH 0.2.0-rc.2 的 `@deepseek-ai/*` 运行时包与 0.1.7-rc.2 **字节相同**，变的是应用层
   加载时序——存储服务不再预放进插件 fiber，所以 1.1.0 那种 `inject: ['storageDomain']` 的
   写法也会以 `cannot get required service ... in inactive context` 失败。）
   锁：`tests/activation.test.ts` 用 `new Proxy(ctx, ...)` 让读 `storageDomain`/`skills`
   直接抛错，断言插件仍能完整激活。

> 教训：`apply()` 里直接传对象给测试是**测不出**前两类的——配置校验发生在 cordis 调用
> `apply` **之前**；第三类要模拟严格代理才测得出。所以要么锁 schema/代理，要么用真实 loader 起一次。

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

### 5.1 发布流程（硬性门槛：先本地实测，再发包）

**不要写完就发。** 发包（`git tag` → CI `npm publish` → GitHub Release）之前必须先在本地把
候选版本装上跑一遍，否则一旦有回归就只能靠 `npm deprecate` 补救，版本号也被浪费掉。

```bash
# 1) 出候选包（不推 tag、不 publish）
npm run build && npm run pack          # → dist/lx-music-for-dsh-<version>.tgz
# 2) 装进 web profile 实测（依赖写成 file: 指向绝对路径，pnpm 不会去 registry 找）
#    dsh web 侧：profile 的 package.json 里 "lx-music-for-dsh": "file:D:/deepseek_harness/lx_plugin/dist/lx-music-for-dsh-<version>.tgz"
#    桌面版：同样用 file: 装，然后重启应用（Electron 主进程需要重启才生效）
# 3) 实测清单见 §9；通过后才：
#    git tag -a v<version> -m "..." && git push origin v<version>   # 触发 CI 校验 + publish
#    并把 tarball 传成 Release asset（GitHub 安装路径依赖它，见 §6.4）
```

发布前还要过一遍 §9 的验收清单；`1.2.0` 起 storage 布局变了，**升级路径本身也要实测**
（旧 `lx_music.json` → per-record 的迁移，见 §7.1），建议用一份真实的老数据来验。

## 6. 安装到 DSH（web 模式）

> 适用 **@deepseek-ai/dsh ≥ 0.1.5-rc.1**。插件包用 `dsh.bundle.patch` 声明自己是一个
> profile 组合层，`dsh plugin add` 会自动激活，**不再需要手工编辑 profile 的
> cordis.patch.yml**（0.1.0-rc.6 时代的手工行会导致
> `duplicate loader entry id: lx-music`，dsh 直接拒绝启动）。
>
> **1.1.0 起同时兼容 0.1.5 与 0.1.7**（client 面同时携带两代 codec 契约），所以默认装最新版
> 即可。只有装**旧版本**才需要配对：1.0.2 仅 0.1.7+、1.0.1 仅 0.1.5-，装错会在 `$mount`
> 抛 `strict codec has no create() factory`（或 0.1.5 侧的 `has no parse() method`）。
>
> **桌面版（Electron 宿主）从 1.1.0 起才可用**：1.0.x 在 Electron 主进程里 spawn 子进程时
> 把 `process.execPath`（= Electron 主程序）当成 node，子进程会以 `code=0` 立即退出，
> 音源校验/导入全部失败。详见 §10.1。

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
dsh plugin --profile web add D:\deepseek_harness\lx_plugin\dist\lx-music-for-dsh-1.2.0.tgz
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
pnpm add https://github.com/CyberryRe/lx_music-for-dsh/releases/download/v1.2.0/lx-music-for-dsh-1.1.0.tgz
```

桌面版插件管理器的「从 URL 安装」也可以直接填上面这个 URL。实测：`pnpm install` 11 秒装好、
`lib/` 齐全、`client.js` 与 npm 上那份 md5 一致（1.0.2 时为 `83C7AA76C7EB`），全程未触发任何构建脚本。

**为什么 `pnpm add github:CyberryRe/lx_music-for-dsh#v1.1.0` 走不通**

pnpm ≥ 10.26 出于供应链安全默认禁止 git 依赖执行 `prepare` 脚本（
[pnpm 10.26 发布说明](https://pnpm.io/blog/releases/10.26)），而本仓库的 `lib/`
被 `.gitignore` 排除，必须现场构建，于是有两道独立的坎：

1. **放行 key 必须精确到 commit + 抓取 URL，且形式不稳定。**
   实测 `allowBuilds: { lx-music-for-dsh: true }`（只写包名）**无效**，仍报
   `ERR_PNPM_GIT_DEP_PREPARE_NOT_ALLOWED`；必须粘贴 pnpm 报错里打印的那一行。而那一行会
   随 pnpm 实际抓取方式变化：

   | 依赖写法 | pnpm 要求放进 allowBuilds 的 key |
   |---|---|
   | `github:CyberryRe/lx_music-for-dsh#v1.1.0` | `lx-music-for-dsh@git+https://github.com/CyberryRe/lx_music-for-dsh.git#<sha>` |
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
>
> 该结论已实测：干净克隆 + `npm i --no-save @deepseek-ai/dsh@0.1.7-rc.2`（npm 会把
> `@deepseek-ai/*` 全部提升到根 `node_modules`）之后，`tsc --noEmit` 与
> `node scripts/build.mjs` 均通过——所以缺的只是"把它声明成依赖"这一步。
> 同一条命令也是 CI 里提供运行时的方式，见 `.github/workflows/release.yml`。

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
| `migrateLegacyDomain` | `true` | 1.2.0 一次性迁移开关：把旧版 `single` 布局的 `lx_music.json` 迁到新的 per-record 布局。仅测试/嵌入方需要关掉 |

### 7.1 存储布局（1.2.0 起：per-record）

1.1.0 及更早用 `single` 布局：整个 domain 是**一份** `$DSH_HOME/storages/lx_music.json`，
**每次写都重写整份文件**。1.2.0 起换成 `per-record`：

```
$DSH_HOME/storages/
├── lx_music.json.migrated-<时间戳>    # 旧版整份文件：迁移时改名搁置（**不删**，可回退）
└── lx_music/                          # 新版：一条记录一个文件
    ├── global.json                    # 播放列表/当前索引/音质/音量/静音/播放模式/设置/画像配置
    ├── logs/_2026-09-11T03_3a47_…json # 键经 storageKey 转义（见下）
    ├── sources/…json
    └── source_order/order.json
```

同时声明了 `invalidRecords: 'backup-and-skip'`：某条记录不匹配 schema 时会被改名为
`<键>.json.bak.<时间戳>` 并跳过，**不再让整个 `open` 失败**。这两条是绑定的——
`backup-and-skip` 只在 per-record 下有效（single 布局只有一份文档，无法"把单条记录挪走"）；
single 下一条坏记录就会让整个 domain 打不开、播放列表/设置全部静默退化为不落盘，
这正是 1.0.1 事故的机制（见 §10.3）。

#### 7.1.1 两条硬约束（1.2.0 桌面版实测踩出来的）

**(1) 表的键会变成文件名，必须 path-safe。** per-record 单元把键直接当文件名，后端要求
键匹配 **`/^[a-zA-Z0-9_-]+$/`**（否则写入报 `per-record key '…' is not path-safe`）。
本插件的键大量含非法字符：`logs` 用 ISO 时间戳（含冒号）、画像表用 `曲名|艺人`、
`platform:tx`、`mood:…@artist:…`。因此**所有写进 storage 的键都统一过
`src/storage/keys.ts` 的 `storageKey()`**：

| 原始键 | 映射后 |
|---|---|
| `2026-09-11` / `order` / `summary` / `id-1` | 原样（已是安全形态，保持可读） |
| `2026-09-11T03:47:40.052Z` | `_2026-09-11T03_3a47_3a40_2e052Z` |
| `platform:tx` | `_platform_3atx` |
| `晴天\|周杰伦` | `__e6_99_b4…` |

规则：安全形态（`^[a-zA-Z0-9][a-zA-Z0-9-]*$`，不含下划线）原样直通；其余编码成
`_` 前缀 + 逐字节 `_xx` 十六进制。两个分支互斥（直通分支不可能以下划线开头）→ **映射单射**；
超长时截断并附 16 位内容哈希。**注意：域内/内存里的键保持原始形态，只在 storage 边界转换。**

**(2) 不能依赖 backend 的 legacy bootstrap。** 它只播种表记录、**不带 `global`**
（播放列表/索引/音质/音量/静音/播放模式/设置全在 global 里）；更要命的是它**不做键校验**，
直接按旧文件的原始键写文件 —— Windows 上冒号非法，于是以
`ENOENT: rename '….tmp' -> '…2026-09-11T03:47:40.052Z.json'` 失败、整个 `open()` 抛错、
插件静默退化成内存存储（这正是 1.2.0 首次上线时的现象）。

**升级时的迁移**（自动，仅一次）因此改成"自己读 → 改名搁置 → 打开 → 显式迁移"：

1. `readLegacyWholeUnit()` 先读出旧数据（无副作用）；
2. 判定需要迁移时 `stashLegacyFile()` 把旧文件改名为 `lx_music.json.migrated-<时间戳>`
   （旧文件不在原路径 → bootstrap 不会触发；**打开失败会 `restoreLegacyFile()` 还原**）；
3. `open(domainSpec)`；
4. `migrateLegacyDomain()`：先表记录（键过 `storageKey`）、后 global，幂等标记
   `global.memory.migratedFrom` 写在 global 上 → 只有 global 写成功才算迁移完成，失败下次重试。

回退方式：删掉 `lx_music/` 目录并把 `lx_music.json.migrated-<时间戳>` 改回原名，
旧版插件即可继续读取。
（但**新版写入的状态会丢**，回退前先备份）。

### 7.2 插件自带的 skill 装在哪里（安装时会不会落地文件）

**不会落地任何文件。** 插件 host 半边在每次激活时调用 `ctx.skills.register(TASTE_SKILL)`
（`src/taste/skill.ts`，`source: 'runtime'`），技能因此是**内存注册**的：

- 装插件 → 技能自动可用，无需手动拷贝（这是"自动安装 skill"的全部含义）；
- 停用/卸载插件 → 技能随之消失，不会在磁盘上留残留；
- 内容随插件版本走：打包进 `lib/index.js`（包的 `files` 只有 `lib/`、`cordis.patch.yml`、
  `manifest.json`、`README.md`，**没有独立的 skill 文件**），改技能文案要重新打包。

DSH 里技能有两种来源（`@deepseek-ai/dsh-skill` 的 provider 体系）：

| 来源 | 落盘位置 | 形态 |
|---|---|---|
| `runtime`（本插件） | **无**（进程内存） | `{ name, description, content, metadata }` |
| `filesystem`/`bundled` | `$DSH_HOME/skills/<技能名>/`（用户级）、`<项目>/.dsh/skills`、`<项目>/.agents/skills`、`customSkillDirs` 配置项 | 目录包（`SKILL.md` + `meta.yaml` + `references/`）或单个 Markdown |

所以想"改插件技能"要改代码重新打包；想加自己的技能（例如 `vibe-music`）就往
`$DSH_HOME/skills/<名字>/` 放一个目录。

> 相关：`ctx.inject(['skills'], cb)` 是**作用域**注入（不是 `inject` 必需依赖），
> 因为 skill 服务在精简宿主里可能不存在——见 §4.1.1 第 1 条。

设置窗口的修改会持久化到该 domain（`global.settings`），
优先于行配置。该 domain 的 schema 是**持久层读边界校验**：任一条存储记录不匹配就会让整个
`open` 失败、插件降级为内存存储，因此改动 schema 必须与代码实际写入的形状逐字段对齐
（见 §10.3 与 `tests/host.integration.test.ts`）。

## 8. 测试

```bash
npm test    # = compile-tests + node --test --test-isolation=none --test-concurrency=1 --test-force-exit
```

> **为什么带 `--test-force-exit`**：音源沙箱会 spawn 子进程，而 `child.unref()` **不会**
> unref IPC channel（实测：只 unref 子进程时父进程事件循环被 channel 撑住、永不退出；
> 补 `channel.unref()` 才干净退出，`src/engine/sandbox.ts` 已修）。这类"用例全过但进程
> 不退出"的问题在 CI 上表现为 job 无限挂起（首次上线时 `test` 步挂了 63 分钟、
> `duration_ms` 3818820 而被强制取消），因此测试脚本强制退出作为兜底，CI 里另有
> job/step 级超时上限。

```bash
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
#   sandbox-env   子进程环境：Electron 宿主注入 ELECTRON_RUN_AS_NODE、白名单不泄漏宿主机密
#   remote-contribution  client 面契约：每个 strict codec 都提供 0.1.7 要求的 create()
#                 且不再暴露 schema、create() 可解析且记忆化、descriptor 通过 wire 层
#                 校验规则、与 PlaybackService 的 @Remote 方法双向一致（方法名 + 形参个数）
#   host.integration  apply 全流程（服务注册/工具集注册/搜索→直链→播放/限流）、
#                 storage domain schema 与写入形状一致性
#   domain-spec    domainSpec 契约：per-record + invalidRecords 成对存在、version 保持 1、
#                 global schema 兼容缺 memory 的老数据、保留 playMode/settings；画像配置的
#                 默认值/夹紧/迁移标记
#   domain-migration  旧 single 整份文件 → per-record：表记录 + global 全量迁移、幂等、
#                 失败不写标记（下次重试）、**绝不修改旧文件**、新值优先的合并策略
#   domain-backend  真实 JSON backend 落盘行为：per-record 下坏记录被改名备份且 open 存活（幂等）、
#                 single 下同一条坏记录让整个 open 失败（1.2.0 离开 single 的原因）
#   taste-events   信号表与归因三拆：完整/部分/切走、AI 切走只按 0.3 记艺人维度、探索负反馈再乘 0.25、
#                 重播加成、情绪×艺人关联、标签 key 构造与本地时段划分
#   taste-normalize  归一化与版本识别（样例取自五平台真实搜索结果）：曲名后缀剥离、多人合唱取主艺人、
#                 全角半角、时长解析、**严格匹配拒绝 RyaVocal 翻唱与时长不符的 Live 版**、
#                 pickBestMatch 无合格候选时返回 undefined（绝不取第 0 个）
#   taste-profile  指数衰减（半衰期数学、增量与一次性重算等价）、**explicit 不衰减**（时间旅行测试）、
#                 plays/skips 计数、置信度门控（low 不许主动推荐）、排序确定性、事件裁剪
#   taste-schema   画像表的持久层 schema：真实 MusicInfo（含 tx 私有字段）被接受且**保留私有字段**、
#                 未知音质/坏枚举被拒、五张表都已在 domainSpec 里（防止只改一边）
#   taste-store    聚合落盘与排行、**seen/played 分离**（探索池的前提）、多平台引用与 Tier-1 直取、
#                 事件按天分桶/单日上限/保留窗口裁剪、探索统计、一键清空，
#                 以及**"store 真实写出的每条记录都能被 domain schema 接受"**（形状漂移的正面锁）
#   activation     **激活路径**：`inject` 只含必需依赖（可选能力必须走作用域注入）、`Config({})` 必须通过、`PLUGIN_VERSION` 与 package.json 一致；以及「无 storageDomain 也照样激活」「存储迟到就绪能补挂画像工具」
#   ui-styles      按钮/卡片两条 CSS 约定：.lxm-btn 用 min-width + nowrap（不依赖父容器）、.lxm-btn-text 自带按钮框、TasteWindow 全部 	ype="button"；**.lxm-card 必须可被压缩（max-width/min-width/overflow）且报错用 .lxm-error 换行两行截断**（否则长报错会撑出侧边栏、盖住设置入口）
#   storage-keys   **per-record 键必须 path-safe**：映射规则（直通/编码/单射/超长哈希）、
#                 真实后端确实会拒绝 ISO 时间戳键（说明这一层不可省）、
#                 含非法字符的旧数据"改名搁置 → 打开 → 显式迁移"能跑通且 global 逐项保留、
#                 （Windows 专属）不搁置直接打开时 bootstrap 因非法键失败
#   taste-recorder 播放捕获：会话生命周期（切歌按已播比例结算、single 重播、暂停恢复不重开会话）、
#                 完整/部分/切走三种结算、**探索负反馈 ×0.25**、播放出错不算偏好、
#                 seen→played 升级、意图信号与来源归因（AsyncLocalStorage）、存储故障隔离，
#                 以及 PlaybackService 钩子的贯通验证
#   taste-tools    画像工具集：profile 的视图/预算档位/关闭态、**Tier-1 命中时零搜索**
#                 （用"search 一被调用就抛错"证明）、Tier-2 精确确认与写回画像、
#                 **显式指定版本是硬要求**（要 Live 不给原唱）、失败时列出未通过校验的候选、
#                 taste 的 like/dislike/forget/note/summary 与关闭态返回 ok=false
#   taste-facade   画像门面（UI/Remote 的读写面）：视图/证据列表/写操作/配置持久化，
#                 以及**关掉开关后立刻停止录制**（不需要重启）、配置写入失败仍本次生效
#   taste-explore  探索（同艺人未听曲目）：排除已听与冷却期内的、**不把翻唱/Live 当新歌**、
#                 过滤搜索噪声（别的艺人）、跨种子轮流取保证多样性；工具的 explore-brief 视图
#                 （样本不足时明说"数据不够"而不是硬凑、画像关闭时不做任何搜索）
#   taste-skill    自带 skill：名字 kebab-case、描述可路由、正文覆盖完整流程且**有长度预算**、
#                 走**真实 cordis 作用域注入**注册（服务缺失时 apply 仍正常、注册抛错只告警）
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
- [ ] `npm test` 全部通过（458 例，运行在镜像的 0.1.7-rc.2 运行时上；双契约用例同时复刻 0.1.5 与 0.1.7 的校验/解码路径）
- [ ] `node scripts/link-dsh.mjs` 报出「与桌面版一致：0.1.7-rc.2」（不一致会拒绝执行，`--allow-drift` 可跳过）
- [ ] `node scripts/install-to-dsh.mjs --profile <p>` 一条命令装好，且包出现在
      profile `package.json` 的 `dsh.profile.bundles` 里（不再需要手工 patch 行）
- [ ] `dsh --profile <p> --dump-config` 中 `lx-music` 行只出现一次，且 profile 覆盖生效
- [ ] 启动日志为 `[lx-music-for-dsh] 插件已加载，provider: …，storage: durable`
      （`storage: memory` 表示持久化不可用，见 §10.3）
- [ ] **桌面版（Electron 宿主）能导入音源脚本**：设置窗口「音源管理」导入 `.js` 不再报
      「子进程在初始化期间退出（code=0）」（该故障见 §10.1）
- [ ] `node scripts/browser-smoke.mjs <url>` 退出码 0：GUI 启动、卡片出现、
      主窗口打开、`setPlayMode` 往返、设置窗口加载音源列表
- [ ] 安装到 web profile 后侧边栏出现卡片，按钮/进度条实时生效
- [ ] 卡片播放列表弹层与主窗口播放列表页可切换四种播放模式（列表循环/单曲循环/随机/顺序），
      单曲循环播完自动重播、顺序播放到末尾停止、随机播放不重复当前曲目
- [ ] LLM 可调用细粒度音乐工具集（music_search/music_play/music_playlist/music_prev/music_next/music_control，
      含防刷与 action 日志）
- [ ] 无 lxserver 时内置引擎全功能可用（搜索开箱即用；导入音源脚本后直链解析正常）；
      配置 lxserver 后搜索/直链/音源管理走真实服务

### 9.0 音量 / 滚动歌词 / 系统媒体控件（1.3.0）的人工实测清单

这三项**只能在本机实测**（单测覆盖了逻辑，但系统媒体面板与真实歌词源不在测试环境里）：

- [ ] **音量**：点卡片上的喇叭图标 → 弹出**一根竖滑块**（面板里没有数值、也没有喇叭按钮），
      拖动 → 声音立刻变化，且**上端 = 100%、下端 = 0%**（滑块位置的填充色应随之从下往上增长）；
      松手后刷新页面/重开窗口，音量仍是拖动后的值（说明已同步到 host）。
      面板**不能被卡片裁断**（这是它改成 portal 的原因）：卡片有 `overflow:hidden`，
      面板由 `VolumePopover` 手写 DOM portal 挂到 `<body>` + `position: fixed`
      （`src/ui/VolumePopover.tsx`），并实时按按钮矩形定位、夹在视口内；
      **把窗口拖矮**时上方放不下应自动翻到按钮下方（箭头朝上），而不是被截断。
      点面板/按钮之外、按 Esc、或把卡片滚出视口都应收起；面板不应把卡片撑高。
      图标本身是内联 SVG 线稿喇叭（不是 emoji）：静音或音量 0 时应变成带斜杠的那版。
      注意：**静音入口只在 host 侧**（`music_control` 工具与设置窗口）——卡片面板刻意不再放静音按钮。
- [ ] **SMTC（系统媒体控件）**：放一首歌，然后打开 Windows 的媒体面板（音量键 / 快速设置 → 媒体）
      —— 面板上应显示**歌名 + 歌手 + 专辑封面**，而不是「<会话名> — DeepSeek Harness」；
      面板与键盘媒体键的播放/暂停/上一首/下一首/快进快退都应生效。
      自查入口：设置窗口「音质策略」页底部的「系统媒体控件（SMTC / 媒体键）」一行
      （歌词窗口底部也有一行），显示「已推送《歌名》… · 已带封面」即表示元数据已交给 Chromium。
      若仍显示会话名：先看那一行的 note（例如"当前内核不支持"），再确认是**通过界面点过播放**
      —— Chromium 需要用户手势才允许起播，没有媒体会话就不会有面板条目。
- [ ] **滚动歌词**（入口当前**已隐藏**：卡片上原「词」按钮的位置换成了喇叭；歌词链路本身完整保留：
      `store.openLyrics/refreshLyric`、`LyricsWindow.tsx`、`WindowsHost` 的 `lyricsOpen` 分支与 host 侧
      `getLyric` 都没动 —— 复测时在 `src/ui/Card.tsx` 的喇叭按钮旁加回那个「词」按钮即可）：
      点「词」→ 歌词窗口自动取词；播放时当前句高亮并自动居中；
      有逐字轴的歌（kw/wy/kg 多数歌）能看到**逐字高亮**；滚轮向上翻会停止跟随，
      点「回到当前」恢复；点任意一行跳到那一句；带翻译的歌点「译」可切换；
      底部的来源角标能看出歌词来自「音源脚本 / 内置 SDK / lxserver / 演示」。
- [ ] **歌词缺失路径**：找一首没有歌词的歌 → 窗口显示明确原因（不是空白、不是崩溃）；
      若已启用实现了 `lyric` action 的音源脚本（仓库自带 `sources/qdy-latest.js` 就是一个），
      角标应显示来源为「音源脚本」。

### 9.2 实验性开关（音乐画像）的人工实测清单

画像是**实验性功能、默认关闭**（`DEFAULT_MEMORY_CONFIG.enabled = false`），且"开启"必须留下显式凭证：

- [ ] **升级后不会自动采集**：从 1.2.0/1.2.1（当时默认开启）升级 → 持久层里可能仍有
      `memory.enabled: true`，但**没有** `memory.experimentalOptInAt` ⇒ 运行时应按关闭处理：
      卡片上没有 ♪ 入口、播放/切歌**不产生** `taste_*` 记录，`logs/` 目录也不再增长（点歌日志同样门控）。
      锁：`tests/domain-spec.test.ts`（无凭证 ⇒ false）。
- [ ] **入口只在总设置里**：设置窗口（⚙）→「实验性」页；未开启时该页是红色警示条 +
      「了解风险并开启…」；口味窗口在未开启时**打不开**（`openTaste` 直接挡回）。
- [ ] **开启要二次确认**：确认框里必须点「我已了解，开启实验性功能」；开启后卡片出现 ♪ 入口，
      且持久层写入 `memory.experimentalOptInAt`（时间戳）。
- [ ] **关闭是即时的**：设置窗口「实验性」页 →「关闭并停止记录」→ 立刻不再记录（无需重启），
      ♪ 入口消失、skill `taste-aware-picking` 被撤下（日志里能看到「画像已关闭，撤下 skill」）。
- [ ] **彻底清除本地数据**：设置 →「实验性」→「清理本机数据」→「彻底清除本地数据…」→ 红色确认
      → 播放列表清空、画像/证据为空、`logs/` 不再有记录；音源脚本仍在（音源管理页）。
      实现：`clearList()` + `tasteAction({action:'clear'})`（后者顺带清 `logs` 表与域外遗留文件）。
- [ ] **卸载会清理本机数据**：卸载插件 → 日志出现「卸载清理：删除 N 项本地数据」，
      `$DSH_HOME/storages/lx_music/`、`lx_music.json.migrated-*`、`lx-music-sources.json*`、
      `lx-music-plugin-status.json` 都没了。
      ⚠️ 清理是**延迟 8 秒 + 可取消**的：期间若插件重新激活（升级/热重载）就取消，
      避免"每次升级都丢播放列表"。行配置 `cleanupOnUninstall: false` 可关闭。
- [ ] **重启提示能在三处看到**：① 插件页/市场的描述文案；② 卡片未连接时的错误行；
      ③ 我们自己抛的激活错误（`ACTIVATION_HINT`）——注意 cordis/DSH 自己抛的错（如
      `without inject`、配置校验错）发生在 `apply` 之前，**改不了**，只能靠 ①② 兜底。
- [ ] **关闭时确实什么都不记**：关闭状态下播放几首歌、切几次歌 →
      `storages/lx_music/logs/` 与 `taste_events/` 的文件数与修改时间都不变。
      锁：`tests/host.integration.test.ts`（关闭时 `service.log()` 不落盘、开启后才落盘）。

### 9.1 音乐画像（1.2.0）的人工实测清单

升级路径本身也要验（storage 从 `single` 换成 `per-record`，见 §7.1）：

- [ ] **升级不丢数据**：用一份真实的旧 `lx_music.json` 启动 → 播放列表/当前索引/音质/音量/静音/
      播放模式/设置**逐项与升级前一致**；`$DSH_HOME/storages/lx_music/` 目录出现（`global.json` +
      各表目录），旧 `lx_music.json` 已改名为 `lx_music.json.migrated-<时间戳>`（**不删**，可回滚）
- [ ] 启动日志出现 `[lx-music-for-dsh] 旧存储已迁移到 per-record 布局：…`
- [ ] **长报错不撑破侧边栏**（1.2.0 实测缺陷）：制造一条长报错（例如断开音源后搜索），卡片应把
      报错**换行并两行截断**在卡片内，侧边栏宽度不变、设置/口味按钮仍可点（`title` 里有完整文本）
- [ ] **坏记录不殉爆**：手工把 `lx_music/taste_tags/<某键>.json` 改成非法形状 → 重新加载插件后
      该文件被改名为 `.bak.<时间戳>`，插件照常可用（`storage: durable`）
- [ ] 首次加载弹出「音乐口味记忆」引导页；「稍后再说」后 7 天内不再自动弹；「暂不使用」后
      卡片 ♪ 里显示为已关闭
- [ ] 侧边栏卡片 ♪ 能随时打开「我的口味」；三个标签页都有内容/空态文案
- [ ] 播放一首歌听到结束 → 「证据」页出现一条 `完整播放`；听到一半切歌 → 出现 `部分播放` 或
      `切走（用户点的）`
- [ ] 让 AI 用 `music_profile` 读画像、用 `music_play_song({title,artist})` 精确点播：
      **播放的必须是点名的那首**（不是翻唱、不是 Live）；点名一首画像里已有的歌时走"画像直取"
      （不产生搜索）
- [ ] 在对话里说"我喜欢某某" → AI 调用 `music_taste({action:'like'})` → 「我的口味」页出现该艺人并标
      `明确喜欢`（且权重不随时间衰减）
- [ ] 「设置」页关掉开关 → 立刻不再新增证据；重新开启后恢复记录
- [ ] 「清空全部画像数据」后榜单/证据清空，播放列表不受影响

## 10. 版本兼容性

| 插件版本 | DSH 版本 | 说明 |
|---|---|---|
| **1.3.0** | **0.2.0**（也兼容 0.1.7 / 0.1.5） | **音量调节**（卡片）+ **滚动歌词窗口**（逐字卡拉OK / 翻译 / 点击跳转）+ **系统媒体控件（SMTC）**元数据/封面与媒体键。歌词来源：音源脚本 `lyric` → 内置五平台歌词 → lxserver → mock；host 侧解析成 `LyricDoc` 并带 6h 缓存。**无新增 npm 依赖、无新增配置项** |
| **1.2.0** | **0.1.5 ～ 0.1.7 均可** | **音乐画像**：本地口味记忆（`music_profile` / `music_play_song` 精确点播 / `music_taste`）+「我的口味」窗口 + 自带 skill；**存储布局 single → per-record**（启动时自动迁移，旧文件保留）+ `invalidRecords=backup-and-skip` |
| 1.1.0 | 0.1.5 ～ 0.1.7 均可 | **双契约**（codec 同时带 `schema` 与 `create()`）+ **桌面版 Electron 沙箱修复**（`ELECTRON_RUN_AS_NODE`） |
| 1.0.2 | `@deepseek-ai/dsh@0.1.7-rc.2` | **client 面契约适配**：Typert strict codec 的 `schema` → `create()`；descriptor 类型改绑 DSH 真实协议类型；`link-dsh.mjs` 支持显式来源 + 桌面版版本漂移比对 |
| 1.0.1 | `@deepseek-ai/dsh@0.1.5-rc.1`（随包依赖 `*-0.1.5-rc.2`） | 声明 `dsh.bundle.patch`，`dsh plugin add` 一条命令激活；`dsh.client.inject` 修正为现存包；client externals 对齐 0.1.5 基线模块表；**修复 storage domain schema 导致的持久化静默失效** |
| 1.0.0 | `@deepseek-ai/dsh@0.1.0-rc.6` | 需要手工在 profile `cordis.patch.yml` 里 insert 插件行 |

### 10.0 1.2.0：音乐画像 + 存储布局切换

**(1) 存储布局 single → per-record（升级时自动迁移）。** 旧版整个 domain 是一份
`$DSH_HOME/storages/lx_music.json`，**每次写都重写整份**；画像要频繁写事件与聚合表，
写放大不可接受。新版是 `lx_music/` 目录（一条记录一个文件）。

为什么不能只靠 backend 的 "legacy bootstrap"（实测见 docs/design-taste-memory.md §2）：
它会从旧整份文件播种**表记录**，但**不带 `global`**——而播放列表/当前索引/音质/音量/静音/
播放模式/设置全在 global 里；而且它只在"新目录完全为空"时生效，任何提前写入都会让它失效。
所以 `apply()` 里做了**显式迁移**：先写表记录（按键覆盖，幂等），最后写 global 与幂等标记
`global.memory.migratedFrom`；失败不写标记、下次启动重试；**旧文件绝不修改或删除**（可回退）。

**(2) `invalidRecords: 'backup-and-skip'`（与 per-record 绑定）。** 某条记录不匹配 schema 时
改名为 `<键>.json.bak.<时间戳>` 并跳过，**不再让整个 `open` 失败**。这条只在 per-record 下有效
（single 只有一份文档，无法"把单条记录挪走"）——1.0.1 的事故正是 single 下一条坏记录让持久化
整体失效。这两条都有回归测试（`tests/domain-backend.test.ts` 用真实 JSON backend 复现）。

**(3) 音乐画像。** 设计与验证结论见 `docs/design-taste-memory.md`；
人工实测清单见 §9.1（升级路径本身也要验）。

### 10.0.1 1.2.1：桌面版实测暴露的三个问题

1.2.0 装到桌面版后"看起来什么都没生效"：`lxPlayback/*` 全 404、`storages/lx_music/` 一直不出现、
  画像工具也不存在。三处根因都在这一版修掉：

**(1) 插件从未被激活（根因）。** 1.2.0 的 `Config` 新增了
`migrateLegacyDomain: z.boolean().required().default(true)`，但**没同步进随包
`cordis.patch.yml` 的行配置** → schemastery 的 `.required()` 要求行配置显式提供 →
cordis `resolveConfig` 判配置非法：

```
启用失败：1 entry did not activate lx-music (lx-music-for-dsh):
ValidationError: invalid config:
- $.migrateLegacyDomain missing required value (at migrateLegacyDomain)
```

`apply()` 因此从未被调用：服务、工具、存储一概不存在（客户端全 404，存储目录当然也不会出现）。
修法：**去掉所有 `.required()`**（默认值即可用），并把字段补进随包 patch；
同时把 `inject` 从 `['tools','storageDomain']` 收紧为 `['tools']` —— `storageDomain` 是**可选**
能力（代码里本来就有内存降级分支），写进必需依赖会让"存储没就绪"升级成"插件完全不存在"。
存储改由作用域注入迟到挂载（`PlaybackService.attachStorage/attachTaste`）。
诊断入口：`$DSH_HOME/lx-music-plugin-status.json`（§4.1）+ 两个陷阱的清单（§4.1.1）。

**(2) per-record 键必须 path-safe，且不能依赖 backend bootstrap。** 见 §7.1.1：
`logs` 的 ISO 时间戳键（含冒号）在 Windows 上让 open() 抛 ENOENT（bootstrap 不校验键），
插件静默退化成内存模式；迁移改为"自己读 → 旧文件改名搁置 → 打开 → 显式迁移"。

**(3) 侧边栏小卡片被长报错撑破。** `.lxm-card` 缺宽度约束，报错文本（含 URL/JSON、无空格）
把卡片撑出侧边栏并盖住设置入口；现在卡片可被压缩、报错单独一行换行 + 两行截断 + `title`。

### 10.0.2 1.2.2：DSH 0.2.0-rc.2 兼容 + 画像改为实验性（默认关闭）

**(1) 0.2.0 兼容：不再直接读未声明的服务。** 桌面版自动更新到 0.2.0-rc.2 后插件报
`启用失败：cannot get property "storageDomain" without inject`。排查结论（用 asar 抽取器
逐包比对）：`@deepseek-ai/*` 运行时包与 0.1.7-rc.2 **字节相同**，变化在应用层的加载时序——
存储服务不再预放进插件 fiber，于是「直接读」和「写进必需 inject」两种写法都会失败。
改法：`apply()` 全程不读 `ctx.storageDomain`/`ctx.skills`，存储与 skill 一律走
`ctx.inject([...], cb)`；服务就绪即挂载（`attachStorage/attachTaste`），未就绪则先在内存模式下
完整可用（服务 + 7 个音乐工具），不再出现「插件整个不存在 → `lxPlayback/*` 全 404」。
锁：`tests/activation.test.ts` 用严格 Proxy 断言「读未声明服务就抛错」时仍能激活。

**(2) 音乐画像改为实验性功能，默认关闭。** `DEFAULT_MEMORY_CONFIG.enabled = false`：
不采集、不参与点歌、**不注册 skill**（skill 跟着开关走，开启即注册、关闭即撤下）。
开启路径必须经过红色警示 + 二次确认（`TasteWindow` 的 `.lxm-danger` 警示条 → `.lxm-modal-card`
确认框 → 唯一一处 `setMemoryConfig({ enabled: true })`），关闭是即时的。
**(3) 实验性开关的收尾（并入总设置）**：开关从「我的口味」窗口搬到**主设置窗口的「实验性」页**；未开启时**不显示 ♪ 入口**（`openTaste` 也挡回、skill 不注册）；**关闭时不写任何音乐行为记录**（含点歌日志 `logs` 表，实测问题：用户以为关了却还在记切歌）；并引入**显式凭证**`memory.experimentalOptInAt` —— 老版本默认开启时代留下的 `enabled: true` 不再生效，必须重新在红色警示后确认。顺带修掉一个真 bug：运行时切换开关原本不影响日志门控（`onMemoryChange` 没有回写 `apply` 作用域的 `memory`）。
回归锁：`tests/ui-styles.test.ts`（危险色/可压缩/唯一写入点/我已了解/入口隐藏）、
`tests/domain-spec.test.ts`（默认关闭）、`tests/taste-skill.test.ts`（门控）。

### 10.1 1.1.0：双契约（一份产物兼容两代 DSH）+ 桌面版沙箱修复

1.1.0 有两个改动，第一个消除了"按 DSH 版本配对安装"这件事，第二个修掉了桌面版上
音源脚本完全不可用的问题。

**(1) client 面 codec 改为"双契约"。** 0.1.5 与 0.1.7 的契约正好相反（详见 §10.2 的对照表），
因此 1.1.0 的 `strictCodec()` **同时**返回 `schema` 与 `create()`：

```ts
const schema = build()            // 0.1.5 直接读它，无法懒加载
return { mode: 'strict', typeSymbol, schema, create: () => schema }
```

0.1.5 只读 `codec.schema`、0.1.7 只读 `codec.create`，双方都不校验"多余字段"，所以同一份
bundle 在两个运行时上都能通过校验并正确解码（已对着 0.1.5-rc.2 与 0.1.7-rc.2 的
`validateCodec` / `decode` 源码逐字核对）。`tests/remote-contribution.test.ts` 逐字复刻了
**两个版本**的校验+解码路径作为回归锁。

**(2) 桌面版（Electron 宿主）音源子进程修复。** 桌面版里插件跑在 Electron 主进程，
`process.execPath` 是 **Electron 主程序**而不是 node：

```
spawn(process.execPath, [runner])   // 桌面版 → 又起一个 GUI 实例
                                    // → 单实例锁 → 立即 code=0 退出
```

用户看到的是：

```
校验失败：音源 temp_validate 子进程在初始化期间退出（code=0）
导入失败：音源 长青SVIP音源(二改修复版).js 子进程在初始化期间退出（code=0）
```

修法是给子进程环境注入 `ELECTRON_RUN_AS_NODE=1`（DSH 自己起内部 Node 脚本用的也是这一招；
旁证：插件管理器日志里 pnpm 的命令行是
`"…\DeepSeek Harness.exe" --expose-internals …pnpm.mjs`）。注意 `buildChildEnv()` 是
**白名单**，所以这个变量必须显式注入，不能指望从 `process.env` 透传。

实测（`spawn(electron, [runner], {env:{ELECTRON_RUN_AS_NODE:'1'}})`）：
`星海音乐源 v2.3.11.js` / `lx-music-source-v6 (修复).js` / `长青SVIP音源(二改修复版) v1.2.0.js` /
`野花音源.js` / `HYWmusic_beta_公益测试 v0.74.0.js` **全部 init OK**。
`tests/sandbox-env.test.ts` 锁定该行为，同时锁住环境白名单不泄漏宿主机密。

### 10.2 升级到 1.0.2：client 面的 strict codec 契约变了

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

### 10.3 升级到 1.0.1 必须处理的两件事

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

### 10.4 回归覆盖

| 测试 | 锁定的行为 |
|---|---|
| `tests/remote-contribution.test.ts` | strict codec 必须提供 `create()`（且不暴露 `schema`）、`create()` 产出可 `parse` 且记忆化、descriptor 通过 wire 校验规则、client 面与 `@Remote` 方法双向一致 |
| `tests/source-store.test.ts` → `DomainSourceStore` 用例 | 旧文件存储一次性合并（采纳缺失/更新的记录、保留 domain 新版本、顺序、改名标记、不传 `legacyFile` 时不合并） |
| `tests/host.integration.test.ts` → `storage domain schema 与写入形状一致` | `source_order` 记录是裸 `string[]`（对象形状必须被拒）、`global` 保留 `playMode`、`sources` 记录字段 |
| `scripts/browser-smoke.mjs` | GUI 能启动（任一 client 行未激活即整体失败）、卡片出现、主窗口打开、`setPlayMode` 参数化 Remote 往返、设置窗口加载音源列表 |

### 10.5 1.3.0（当前版本）：音量 / 滚动歌词 / 系统媒体控件

**(1) 没有断裂点，但有三处"环境能力"要认。** 版本号只动了插件；升级只需彻底重启 DSH。
三项新能力都按"能力缺失就降级"实现，任何一项不可用都不影响播放：

- **SMTC** 需要内核提供 `navigator.mediaSession`（Electron/Chromium 有；非 Chromium 内核则整桥空操作）。
- **歌词的酷我链路**需要 Node 的 `TextDecoder('gb18030')`；**网易云歌词**需要 Brotli 解压
  （`src/sdk/request.ts` 补了 `content-encoding: br` 分支）。都是 Node 内置能力，无新增依赖。
- **歌词本身可能没有**：这不是错误，窗口会显示具体原因（`LyricDoc.note`）。

**(2) 为什么"SMTC 一直显示会话名"**：页面标题由 `dsh-client-ui-layout` 设成
`<会话名> — DeepSeek Harness`，而 Chromium 在没有 `MediaMetadata` 时就用**页面标题**当默认元数据。
插件此前从未写过 metadata，所以面板只能显示会话名。现在 `src/ui/mediaSession.ts` 会在**任何状态下**
（包括"没有曲目"）都写一份非空 metadata，并在设置窗口「音质策略」页与歌词窗口底部显示"实际推了什么"
（系统面板没有回读 API，这是唯一的自查入口）。

**(3) 新增/变更的文件**：`src/shared/lrc.ts`、`src/sdk/lyric.ts` + `src/sdk/<平台>/lyric.js`、
`src/ui/mediaSession.ts`、`src/ui/LyricsWindow.tsx`；`getLyric` remote 方法（host ← client）。
歌词解析只在 host 做一次（纯函数，可单测），client 只渲染。

**(4) 验收**：见 §9.0 的人工实测清单（音量 / SMTC / 滚动歌词 / 歌词缺失路径）。
