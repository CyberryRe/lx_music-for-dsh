# lx-music-for-dsh

LX Music 增强控制插件 —— 为 [deepseek_harness](https://github.com/deepseek-ai/deepseek-harness)
Web 模式提供 LX Music 播放控制界面与 LLM 点歌能力。

## 功能

- **侧边栏迷你播放卡片**（位于「设置」按钮上方）：封面缩略图、歌名-歌手、可拖动/点击跳转的
  进度条（与播放器双向同步）、上一首/播放暂停/下一首、播放列表弹窗、设置齿轮。
- **主窗口**（点击卡片主体打开，可调大小、记忆位置）：搜索（关键词/歌手/平台过滤）、
  搜索结果（音质标识、时长、+队尾 / +下一首）、播放列表管理（拖拽排序、删除、清空、导出为文本）。
- **设置窗口**（点击齿轮打开）：音源管理（文件/URL/粘贴导入并自动启用、启用/禁用/删除/排序）、
  音质策略（全局默认音质、每音源平台优先级）、自动拉取规则（切歌自动最高音质、降级策略）。
- **LLM 点歌工具 `search_and_play`**：搜索 → 直链预览 → 加入播放列表（或直接播放）；
  内置滑动窗口防刷（默认 6 次/分钟）与点歌日志。

## 架构

- **完全独立**：搜索由**内置音乐 SDK** 提供（移植自 lx-music-desktop，酷我/酷狗/QQ音乐/网易云/咪咕
  五平台）；直链解析由**内置音源脚本引擎**提供（node:vm 沙箱执行 lx-music-desktop 音源脚本协议，
  与 lx-music-desktop v2.12.2 一致——直链 100% 依赖音源脚本）；播放为浏览器 HTML5 Audio。
  无需任何外部服务即可使用。
- host（Node）：`PlaybackService`（Typert Remote `lxPlayback`，播放权威状态 + storage 持久化）、
  `search_and_play` 工具、内置 SDK 搜索、音源脚本沙箱（导入/启用/排序/删除本地管理）、
  可选 lxserver 客户端（超时 10s / 重试 2 次 / 音质与平台降级链）。
- client（浏览器）：React UI（注入 `sidebar.footer.action` slot）+ HTML5 Audio 播放引擎，
  轮询 host 状态（500ms）diff 应用，进度节流上报（1s）。
- provider 门面（`providerMode`）：`engine`（默认，内置引擎）/ `lxserver`（连接 lxserver 同步服务器）/
  `auto`（有地址用 lxserver 否则引擎）/ `mock`（内置演示数据，用于无网络演示）。

## 快速开始

```bash
npm install && node scripts/link-dsh.mjs
npm run lint && npm run typecheck && npm run build && npm test
# 可选：真实网络冒烟（五平台搜索）
node scripts/compile-tests.mjs && node scripts/smoke-live.mjs
```

安装到 DSH：见 [docs/development.md](docs/development.md)（§6）。

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

- [研读笔记：LX Music 生态](docs/research-lxmusic.md)
- [研读笔记：DSH 插件系统](docs/research-dsh.md)
- [开发文档（调试/打包/安装/测试/验收）](docs/development.md)

## 目录

```
manifest.json  插件清单
src/index.ts   host 入口
src/client.ts  client 入口
src/ui/        React 组件
tests/         单元测试（56 例）
```
