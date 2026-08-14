# 研读笔记：deepseek_harness（DSH）插件系统

> 研读对象：全局安装的 `@deepseek-ai/dsh@0.1.0-rc.6`（C:\Users\11343\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh）
> 及其依赖树中的全部 `@deepseek-ai/dsh-*` 包（编译后 JS + .d.ts）。
> 运行中的 profile：`C:\Users\11343\.dsh\profiles\web`（web 模式，端口 3080）。

---

## 1. 总体架构

- `dsh` 是启动器：`dsh --profile web` 启动 web 应用（别名 `dsh web`）。
- **Profile**（`$DSH_HOME/profiles/web/`）：
  - `package.json` 的 `dsh.profile.bundles` 列出组合包（bundle）：`@deepseek-ai/dsh-base` → `@deepseek-ai/dsh-web-app`。
  - `cordis.patch.yml`：用户 patch 层（追加/覆盖插件行）。
- **组合包** = npm 包 + `cordis.patch.yml`（定义插件行 `{id, name, config}` 的 insert 列表）。
- 插件框架 = **cordis**（`@deepseek-ai/cordis`，Koishi 同款）。
- 配置树叠加顺序：bundles patch → profile patch → home patch → `--patch` 覆盖。**patch 按行替换 config（无深度合并）**。
- 行 ID 覆盖：后写覆盖先写（web-app 覆盖 base 的行）。

## 2. 插件行（cordis.patch.yml）

```yaml
# host 行（Node 侧）
- insert:
    - id: my-plugin
      name: 'my-plugin-package'        # npm 包名
      config:
        key: value
    - id: my-plugin-disabled
      name: 'my-plugin-package'
      disabled: true
# 覆盖已有行：同 id 顶层条目，config 整体替换
- id: tool-todo
  disabled: true
```

- web 模式：agent 相关的 tool 行从 host plane 移到 **agent-preset**（见 §6）。
- `dsh.plugin --profile web add <pkg>` 通过 pnpm 安装包到 profile。

## 3. 插件包结构（host + client 双端）

以 `@deepseek-ai/dsh-client-ui-sidebar` 为例：

```jsonc
// package.json
{
  "type": "module",
  "main": "lib/index.js",                    // host 侧 cordis 插件入口
  "exports": { "./client": { "types": "...", "default": "./lib/client.js" } },
  "dsh": { "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-connection", "..."], "immediately": false } },
  "files": ["lib/..."]
}
```

### host 侧 `lib/index.js`

```js
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

const name = "tool-todo";          // 插件名（行 id 无关，但惯例一致）
const inject = ["tools"];          // cordis 服务注入列表
const Config = z.object({ allowParallelInProgress: z.boolean().required() }); // schemastery 配置 schema

function apply(ctx, config) {      // 生命周期入口（ctx = cordis Context）
  ctx.tools.register(defineTool({ ... }));
}
export { Config, apply, inject, name };
```

### client 侧 `lib/client.js`（浏览器 bundle）

```js
window.__ModuleLoader__.load({
  id: "@deepseek-ai/dsh-client-ui-sidebar",   // 包名
  factory: (require) => {
    let react = require("react");
    let react_jsx_runtime = require("react/jsx-runtime");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    // ...（组件代码，CSS 以 <style data-plugin-css> 注入）
    const inject = ["slots", "layout", "sessions", "workspaces", "locale"];
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register("ns", { zh, en }), "label");
      ctx.slots.register({ name: "sidebar", children: {...}, inject: () => ({...}) }, SidebarRoot);
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
```

- client bundle 由 `dsh-client-modules`（Node 半）扫描：包声明 `dsh.client.platform==='web'`
  → 组装 `window.__DSH_BOOT__` 图 → 浏览器 kernel 按注入依赖顺序加载 `/plugins/<id>/client.js`。
- client 代码中 CSS：`document.head` 注入 `<style data-plugin-css="<tagId>">`（幂等检查）。
- `__ModuleLoader__.load({id, factory})`：factory 内的 require 走模块表（react 等由 shell kernel 提供）。

## 4. Slot 系统（UI 注入点）

```js
ctx.slots.register({ name, id?, key?, locale, children?, scope?, inject }, Component);
ctx.slots.inject(slotName, () => ctx.slots.register(...));  // 惰性/动态注册（挂载时执行）
// 父组件内：renderSlot("slot.name", props)
```

| Slot | kind | 说明 |
|---|---|---|
| `sidebar.workspaces` | single/root | 侧边栏中部区域（会话/工作区浏览器） |
| `sidebar.settings` | single/root | 侧边栏底部固定（设置按钮） |
| `sidebar.footer.action` | **list**/root | 侧边栏底部「设置上方」动作区 —— **迷你卡片注入点**（ui-cordis 的 CordisPanel 也注入此处，多个注册者并列渲染） |
| `tool.call.toolview` | keyed/session | 工具调用卡片（按工具 key 匹配业务视图） |
| `settings.section` | keyed | 设置页分区（ui-settings-plugins：tab + 卡片） |

- 注入的 props 由注册者的 `inject` 函数提供（每次渲染调用）。
- `ctx.effect(fn, label)`：注册副作用（disposer 语义）。

## 5. client ↔ host 通信（Typert Remote）

### host 侧（`dsh-typert-protocol`）

```js
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";

class PluginInventoryGateway extends TypertRemoteService {
  static inject = ["loader"];
  constructor(ctx) { super(ctx, "pluginInventory"); }   // serviceKey = client 侧调用名
  @Remote("list")                                        // 方法装饰器（暴露为 Remote 端点）
  list() { ... }
}
```

- gateway（`dsh-api-gateway`）通过 `typertRemote` 绑定 + `remoteMethods()` 标记自动发现并暴露；
  端点 = `<namespace>/<method>`（namespace 默认 = serviceKey）。
- Remote 方法的参数/返回值**必须可 JSON 序列化**。

### client 侧

```js
const inject = ["remote", "remote.dynamicCordisRunner", ...];
// 调用（answered 包装）：
const answered = await ctx.remote.dynamicCordisRunner.inventory();
if (!answered.ok) throw new Error(`${answered.error.code}: ${answered.error.message}`);
const value = answered.value;
// 事件订阅（仅 allowlist 内事件可收）：
ctx.remote.$on("cordis/dynamic-package", () => {...});
```

- **事件 allowlist** 在 `dsh-api-remotes` 的 `API_REMOTE_FORWARDED_EVENTS`（包内常量，第三方不可扩展）
  → 插件状态同步采用 **client 轮询 Remote** 方案（如每 500ms `getState()`），不依赖 host 推送。
- Remote 调用需考虑 `connection/reset`（`ctx.on("connection/reset")` 重连刷新）。

## 6. LLM 工具注册（web 模式的 agent plane）

- 工具注册表 `tools` 在 **host plane**（`ctx.tools.register(defineTool(...))`）。
- web 模式下，`tool-*` 行从 host 移到 **agent-preset**：`config/agent-presets/standard/agent.cordis.yml`
  （shipped preset 只读；用户自定义在 `$DSH_HOME/.agent-presets`）。
- preset 行结构与 host 行相同，但处于 preset realm（每会话作用域）。
- **第三方插件注册工具**：host 行中直接 `ctx.tools.register(...)` → 注册进 tools registry 的
  global layer → **所有会话的 agent 均可见**（适合"内置插件"定位）。
- `defineTool` 结构（`@deepseek-ai/dsh-tools`）：

```js
ctx.tools.register(defineTool({
  name: "todo_write",
  description: "...",                       // 模型可见说明
  parameters: { todos: { type: "array", required: true, items: {...} } },  // JSON Schema
  output: { schema: {...}, render: (_args, value) => [{ type: "text", text: "..." }] },
  execute(args, exec) { return Promise.resolve(value); },   // exec.agent 可用
  presentCall: (args) => ({ card: "generic", title: "...", kind: "other", rawInput: args })
}));
```

## 7. 配置与持久化

- **插件配置**：`Config = z.object({...})`（schemastery）→ 行配置由 patch 提供；
  `ui-settings-plugins` 可为暴露 sections 的插件渲染设置卡片（`settings.register` 机制，可选集成）。
- **持久化**：`ctx.storage.domain`（`dsh-storage-domain`，web profile 已挂载，后端 = `$DSH_HOME/storages` JSON）：
  - `domain.global.get() / set(value)` — 全局单例
  - `domain.table(name).get/put/delete/update/entries/keys/size` — KV 表（写后持久化 + `domain/changed` 事件）
  - 域声明：`{name, global?, tables?}`（见 `dsh-storage-domain` 的 spec）

## 8. 安装 / 调试 / 打包（对本插件的可执行流程）

1. **打包**：host → ESM 单文件（`lib/index.js`，可用 esbuild）；client → 浏览器单文件 bundle
   （`lib/client.js`，自包含 React 代码，`window.__ModuleLoader__.load` 包装）。
2. **安装**：
   - `cd $DSH_HOME/profiles/web && pnpm add <本地路径或包名>`（或 `dsh plugin --profile web add ...`）
   - 编辑 `$DSH_HOME/profiles/web/cordis.patch.yml` 追加：
     ```yaml
     - insert:
         - id: lx-music
           name: 'lx-music-for-dsh'
           config: { lxServerUrl: 'http://127.0.0.1:23332' }
     ```
   - 重启 `dsh web`（client bundle 变化后浏览器刷新；host 变化需重启进程）。
3. **调试**：浏览器 DevTools 看 client 错误；host 日志在启动 dsh 的终端；
   `--dump-config` 可检查组合配置树。

## 9. 最小模板（必须实现的方法列表）

- `lib/index.js`：`export { name, inject, Config, apply }`（host 插件；apply 中注册 Remote 服务、工具、storage 域）。
- `lib/client.js`：`window.__ModuleLoader__.load({id, factory})`，factory 导出 `{apply, inject}`；
  apply 中 `locale.register` + `slots.inject/register`（UI）+ 轮询 remote。
- Remote 服务：`extends TypertRemoteService` + `@Remote` 方法（JSON 序列化）。
- 工具：`ctx.tools.register(defineTool({name, description, parameters, output, execute, presentCall}))`。
