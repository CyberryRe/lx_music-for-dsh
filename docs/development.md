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
# 保证开发/测试与 DSH 运行时版本一致（0.1.0-rc.6）。npm install 后需重跑本脚本。
```

要求：Node ≥ 20（测试建议 Node 24，`node --test` 支持 `--test-isolation`）。

## 3. 常用命令

| 命令 | 说明 |
|---|---|
| `npm run build` | 构建 `lib/index.js`（host）与 `lib/client.js`（client bundle） |
| `npm run typecheck` | `tsc --noEmit` 类型检查 |
| `npm run lint` | ESLint（0 警告阈值） |
| `npm test` | 编译并运行全部单元测试（90 例） |
| `npm run pack` | 构建 + `npm pack` 产出可安装 tarball |

> 受限环境提示：本仓库的构建（rollup）、测试（node:test 单进程）与 lint 均为纯进程内实现，
> 不依赖子进程 spawn，可在文件沙箱中运行。vitest 因进程池需要 spawn 子进程而未采用；
> 常规环境可直接使用 vitest 运行 `tests/`（断言兼容）。

## 4. 调试

### 4.1 host 侧（服务端）

- 在 DSH 进程日志中查看：`[lx-music-for-dsh] 插件已加载，provider: engine|lxserver|mock`。
- 插件行配置错误会在启动时以 FAILED fiber 报告（`dsh --profile web --dump-config` 可检查组合配置）。

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
#   lib/client.js   浏览器 bundle（window.__ModuleLoader__.load 包装，external：react 等 kernel 模块）
npm run pack        # 生成 lx-music-for-dsh-<version>.tgz
```

## 6. 安装到 DSH（web 模式）

### 6.1 常规安装（tarball）

```bash
cd %USERPROFILE%\.dsh\profiles\web
pnpm add D:\deepseek_harness\lx_plugin\lx-music-for-dsh-0.2.1.tgz
# 或 dsh plugin --profile web add <tgz 路径>
```

编辑 `%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml`：

```yaml
- insert:
    - id: lx-music
      name: 'lx-music-for-dsh'
      config:
        lxServerUrl: ''                        # 可选：lxserver 地址（默认用内置引擎）
        providerMode: 'auto'                   # auto/engine/lxserver/mock
        defaultQuality: '320k'
        platformPriority: ['wy', 'tx', 'kg', 'kw', 'mg']
        autoPullHighestOnSwitch: true
        fallbackStrategy: 'both'
        rateLimitPerMinute: 6
```

重启 `dsh web`，刷新浏览器：
- 侧边栏底部「设置」按钮上方出现 LX Music 迷你卡片（含播放模式切换按钮）；
- 模型工具列表中应包含细粒度音乐工具集：`music_search` / `music_play` / `music_playlist` /
  `music_prev` / `music_next` / `music_control`（以及兼容入口 `search_and_play`）。

### 6.2 开发期安装（本地路径）

```bash
cd %USERPROFILE%\.dsh\profiles\web
pnpm add D:\deepseek_harness\lx_plugin
```
改代码后：`npm run build` → 重启 `dsh web`（host 变更）或仅刷新页面（client bundle 变更，
`rev` 查询参数变化后浏览器会重新拉取 `/plugins/lx-music-for-dsh/client.js`）。

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

设置窗口的修改会持久化到 `$DSH_HOME/storages`（storage domain `lx_music`），优先于行配置。

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
#                 音源管理（上传/启停/删除/校验）、本地持久化、SDK 结果规范化
#   host.integration  apply 全流程（服务注册/工具集注册/搜索→直链→播放/限流）
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
- [ ] `npm run build` 生成 lib/index.js + lib/client.js
- [ ] `npm test` 全部通过
- [ ] 安装到 web profile 后侧边栏出现卡片，按钮/进度条实时生效
- [ ] 卡片播放列表弹层与主窗口播放列表页可切换四种播放模式（列表循环/单曲循环/随机/顺序），
      单曲循环播完自动重播、顺序播放到末尾停止、随机播放不重复当前曲目
- [ ] LLM 可调用细粒度音乐工具集（music_search/music_play/music_playlist/music_prev/music_next/music_control，
      含防刷与 action 日志）
- [ ] 无 lxserver 时内置引擎全功能可用（搜索开箱即用；导入音源脚本后直链解析正常）；
      配置 lxserver 后搜索/直链/音源管理走真实服务
