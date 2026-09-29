# 版本台账（唯一事实来源）

DSH 迭代很快，且**断裂点常常不在包版本号上**（0.1.7 → 0.2.0-rc.2 的全部运行时包字节相同，
断的是应用层的加载时序）。所以维护这个文件，把三件事固定下来：

1. **哪条插件线配哪代 DSH**（下表）；
2. **每次 DSH 跳跃的断裂点是什么**（第二节）——这是真正会咬人的东西；
3. **发布流程与 dist-tag 规则**（第三节）+ 一键自检 `npm run release:check`。

> 规则：**只维护一条线（当前 1.2.x）**。旧线一律只做"标记说明 + 指向新线"，不再回补功能。

## 一、插件 × DSH 对照表

| 插件版本 | 目标 DSH | npm 状态 | 说明 |
|---|---|---|---|
| **1.2.2** | **0.2.0**（也兼容 0.1.7 / 0.1.5） | ✅ `latest` + `lts` | **推荐**。可选依赖全部改为作用域注入（0.2.0 适配）；音乐画像改为**实验性、默认关闭**（红色警示 + 二次确认）；卸载时清理本地数据；安装/更新后**需彻底重启 DSH** |
| 1.2.1 | 0.1.7 | 未发布 | 直读 `ctx.storageDomain` → 在 0.2.0 上抛 `without inject`，插件完全不激活 |
| 1.2.0 | 0.1.7 | 未发布 | `Config` 里写了 `.required()` 却没同步进随包 patch → 从未被激活过 |
| **1.1.0** | **0.1.7**（也兼容 0.1.5） | ✅ 已发布 · **保留可用（不弃用）** | 仍在 0.1.x 的用户用它。⚠️ **0.2.0 及以上无法激活**：把 `storageDomain` 写进必需 `inject`。声明写在 README 对照表里，npm 上**不**打弃用标记 |
| 1.0.2 | 0.1.7 及以后 | 已发布 · **已弃用** | strict codec 契约切到 `create()`；另有导入音源问题 |
| 1.0.1 | 0.1.5 及更早 | 已发布 · 保留 | 0.1.7+ 不兼容（codec 契约相反） |
| 1.0.0 | `@deepseek-ai/dsh@0.1.0-rc.6` | 已发布 | 需手工写 profile patch 行 |

**怎么选**：DSH **0.2.0+** → `lx-music-for-dsh@latest`（1.2.2）｜DSH **0.1.7** → 1.1.0（能升 DSH 就直接用 1.2.2）｜DSH **≤ 0.1.5** → 1.0.1。

## 二、每次 DSH 跳跃的断裂点（真正会咬人的地方）

| DSH 变化 | 断在哪 | 插件侧的正确写法 |
|---|---|---|
| 0.1.5 → 0.1.7 | Typert strict codec 契约**相反**：0.1.5 要 `codec.schema`，0.1.7 要 `codec.create()` | client 面**双契约**（1.1.0 起：同时带 `schema` 与 `create()`） |
| 0.1.7 → 0.2.0-rc.2 | 应用层**不再把存储服务预放进插件 fiber**（运行时包字节完全相同，`dsh-base` 依旧挂载 storage 三行） | 可选能力**只能**用 `ctx.inject([...], cb)` 作用域注入；写进必需 `inject` 会永不激活，直接读会抛 `cannot get property "…" without inject`（1.2.2 起） |

排查入口（都在 docs/development.md）：§4.1 自诊断状态文件、§4.1.1「插件没生效的三个陷阱」、
§7.1.1 per-record 键与迁移的两条硬约束。

## 三、发布流程（三步，别凭记忆）

```bash
# 0) 发布前自检：版本三处一致 / 工作区干净 / 门禁全绿 / 产物 sha1
npm run release:check

# 1) 提交并推代码 + 打标签（CI 会跑 lint/typecheck/build/test 后发布到 npm）
git add -A && git commit -m "chore(release): 1.2.x"
git tag -a v1.2.2 -m "1.2.2: …" && git push origin main v1.2.2
```

若 CI 不可用（或 npm 上的 Trusted Publisher 没配好），本地补发（维护者账号是
`auth-and-writes`，会要求一次性验证码）：

```bash
npm publish --ignore-scripts --access public          # 用已验证过的产物，不重跑构建
npm dist-tag add lx-music-for-dsh@1.2.2 lts           # 让 lts 与 latest 指向同一版本
```

**dist-tag 规则**：`latest` 与 `lts` 永远指向同一条"当前推荐线"；旧线只用 `npm deprecate`
写说明，不占 tag。弃用文案模板：

```bash
npm deprecate "lx-music-for-dsh@<旧版本>" "<它适配哪代 DSH>：<在哪些版本上不工作>。<该用什么替代>。"
```

**撤回（撤销）弃用**：用**空说明**覆盖即可，不需要重新发布：

```bash
npm deprecate "lx-music-for-dsh@<版本>" ""      # bash / zsh
cmd /c 'npm deprecate "lx-music-for-dsh@<版本>" ""'   # Windows PowerShell 5.1
```

> ⚠️ Windows PowerShell 5.1 会把**空字符串参数直接吞掉**（实测 `node -e "…" ""` 收到的 argv 长度为 1），
> 于是 `npm deprecate pkg ""` 会报用法错误。必须用 `cmd /c '…'` 包一层（此时空参数能正常传入，
> argv 长度 2）。PowerShell 7.3+ 默认已修好这个行为。
```

## 四、发布前必查清单

- [ ] 版本号三处一致：`package.json` / `manifest.json` / `src/status.ts` 的 `PLUGIN_VERSION`（有测试锁）
- [ ] `cordis.patch.yml` 的 config 能通过 `Config` 校验（**每个新增配置项都要同步进去**，且**不要**用 `.required()`）
- [ ] `inject` 里只有真必需的服务；可选能力全部走作用域注入
- [ ] README 顶部的"安装/更新后需彻底重启 DSH"提示与当前现实一致
- [ ] 本文件第一节的对照表已更新
- [ ] `npm test` 全绿、`npm run typecheck` / `npm run lint` 干净
