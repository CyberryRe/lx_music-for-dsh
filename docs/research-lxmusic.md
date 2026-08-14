# 研读笔记：LX Music 生态（lx-music-desktop / lxserver）

> 研读对象：`D:\Project\lxserver`（LX Music Sync Server v1.9.4，与 lx-music-desktop 同源生态）。
> lx-music-desktop 源码不在本机，但 lxserver 与其共享同一套数据模型（`src/common/types/*.d.ts`）、
> 音源脚本协议（`src/server/userApi.ts`）与播放器状态结构（`src/common/types/player.d.ts`），
> 足以支撑插件的对接设计。

---

## 1. 数据模型（LX 全局命名空间）

### 1.1 歌曲信息 `LX.Music.MusicInfo`（`src/common/types/music.d.ts`）

```ts
interface MusicInfoBase<S> {
  id: string        // 唯一标识（平台内）
  name: string      // 歌名
  singer: string    // 歌手
  source: S         // 来源: 'kw' | 'wy' | 'kg' | 'tx' | 'mg' | 'local'
  interval: string  // 格式化时长，如 "03:55"
  meta: MusicInfoMetaBase
}

interface MusicInfoMetaBase {
  songId: string | number   // 歌曲 ID（mg 源为 copyrightId，local 为文件路径）
  albumName: string
  picUrl?: string | null    // 封面图
}

interface MusicInfoMeta_online extends MusicInfoMetaBase {
  qualitys: MusicQualityType[]          // [{type: '128k', size: '3.56M'}, ...]
  _qualitys: Partial<Record<Quality, { size: string | null }>>
  albumId?: string | number
}
// 平台特有字段：
//   kg:  meta.hash, meta.albumId
//   mg:  meta.copyrightId, meta.lrcUrl, meta.mrcUrl, meta.trcUrl
//   tx:  meta.strMediaMid, meta.id, meta.albumMid
```

- 音质枚举 `LX.Quality`：`128k / 320k / flac / flac24bit / flac32bit / wav`（`api-source-info.ts` 注释确认）。
- 直链解析时音源脚本要求把 `meta` 字段**提升到顶层**并做平台映射（见 §4.2）。

### 1.2 播放器状态 `LX.Player.Status`（`src/common/types/player.d.ts`）

```ts
interface Status {
  status: 'playing' | 'paused' | 'error' | 'stoped'
  name: string; singer: string; albumName: string; picUrl: string
  progress: number; duration: number
  volume: number; mute: boolean
  // 歌词等字段省略
}
```

- 播放器控制动作枚举：`prev / pause / play / next / seek / volume / mute`（`StatusButtonActions`）。
- 列表管理动作（`src/common/types/list.d.ts`）：`addMusicLocationType` 决定添加位置（队尾/下一首），
  列表操作含 `ListActionMusicAdd / Move / Remove / UpdatePosition / Clear` 等 —— 插件主窗口的
  「队尾 / 下一首播放」即对应此语义。

---

## 2. 内置音乐 SDK 与搜索流程

`src/server/server.ts` 中内置 `musicSdk`（kw/wy/kg/tx/mg 五平台 SDK），通过 HTTP API 暴露：

### GET `/api/music/search`
```
参数: name(必填), singer, source(默认 kw), type(song|singer|album|playlist),
     limit(默认20), page(默认1), pages(默认1, 一次拉取几页)
流程: musicSdk[source].musicSearch.search(name, page, PAGE_SIZE) 逐页拉取
返回: 歌曲数组（MusicInfo 结构，含 meta.qualitys）
```
- 扩展搜索：`extendSearch.searchSinger / searchAlbum / searchPlaylist`（部分源支持）。
- 其他只读接口：`/api/music/tipSearch`、`/artistDetail`、`/artistAlbums`、`/artistSongs`、
  `/albumSongs`、`/hotSearch`、`/songList/*`、`/leaderboard/*`、`/api/music/lyric`(POST)。

### 直链解析：POST `/api/music/url`
```
请求体: { songInfo, quality, enableAutoSwitchApiSource }
   songInfo 先经 normalizeSongInfo() 标准化（meta 字段提升）
返回: { url, type, sourceName, attempts }
```
- 优先走自定义源（`callUserApiGetMusicUrl`），失败才报错（内置 SDK 无独立解析能力）。
- 服务端会做 301/302/307/308 重定向解析（最多 3 层，HEAD 探测）。
- 进度可经 `GET /api/music/progress?reqId=`（SSE）推送每次尝试结果（`{name, status: success|fail, message}`）。

---

## 3. 自定义音源脚本协议（lx-music-desktop 兼容）

来源：`src/server/userApi.ts`（vm2/原生 VM 沙箱加载）。这是 LX Music 生态的**音源脚本标准**，
lx-music-desktop 的「自定义音源」与其一致。

### 3.1 脚本头部元数据（JSDoc 注释，`extractMetadata` 解析）

```js
/**
 * @name 源名称
 * @description 描述
 * @version 1.0.0
 * @author 作者
 * @repository https://github.com/xxx  (或 @homepage)
 */
```

### 3.2 沙箱注入的 `lx` 全局对象

```js
lx = {
  version: '2.0.0',
  env: 'desktop',        // 脚本据此判断运行环境
  platform: 'web',
  currentScriptInfo: { name, description, version, author, homepage, rawScript },
  EVENT_NAMES: { request: 'request', inited: 'inited', updateAlert: 'updateAlert' },
  utils: {
    buffer: { from, bufToString },
    crypto: { md5, aesEncrypt, rsaEncrypt, randomBytes },
    zlib: { inflate, deflate },
  },
  request(url, options, callback),   // options: {method, timeout, headers, body, form, formData}
                                     // callback(err, response, body)，返回 abort 函数
  send(eventName, data),             // 'inited' 携带 {sources}；'updateAlert' 触发更新告警
  on(eventName, handler),            // 'request' 注册请求处理器
}
```

### 3.3 请求处理器（直链解析入口）

```js
lx.on('request', async ({ action, source, info }) => {
  if (action === 'musicUrl') {
    // info = { musicInfo, quality, type }
    // musicInfo 已标准化（顶层含 songmid/hash/copyrightId/strMediaMid 等）
    return 'https://...直链'   // 解析失败 throw Error
  }
})
lx.send('inited', { sources: { kw: { name: 'xx', type: 'xx' }, wy: {...} } })
// 脚本必须在 3 秒内调用 lx.send('inited')，否则初始化超时
```

### 3.4 songInfo 平台字段映射（`callUserApiGetMusicUrl` 标准化）

| 通用 | songId→songmid | picUrl→img | qualitys→types | _qualitys→_types |
|---|---|---|---|---|
| kg | hash | albumId | | |
| mg | copyrightId | lrcUrl | mrcUrl | trcUrl |
| tx | strMediaMid | albumMid | id | |

### 3.5 直链降级 / 平台优先级策略（可复用模式）

1. 收集所有**支持该 source 且已启用**的候选源（公开源 + 当前用户私有源，按用户状态覆盖）。
2. 按 `order.json`（用户配置的音源优先级）对候选排序。
3. `enableAutoSwitchApiSource === false` → 只用第一个候选（用户显式锁定音源）。
4. 单源 → 重试 3 次（间隔 1s）；多源 → 逐个轮询，任一成功即返回。
5. 每次尝试记录 `attempts: [{name, status, message}]` 返回给前端展示。
6. 全部失败 → 抛错（消息含音源日志），HTTP 500 + `{error, code, attempts}`。

### 3.6 音源管理 HTTP API（`src/server/customSourceHandlers.ts`）

| 接口 | 方法 | 说明 |
|---|---|---|
| `/api/custom-source/validate` | POST | `{script}` → 提取元数据 + 试运行，返回 `{valid, metadata, sources, sourcesCount}` |
| `/api/custom-source/upload` | POST | `{filename, content}` → 保存脚本，**默认 enabled:false**，随后 `initUserApis` 重载 |
| `/api/custom-source/import` | POST | `{url, filename}` → 下载远程脚本（支持 5 层重定向）后同 upload |
| `/api/custom-source/list` | GET | 合并 open+user 源，`enabled` 优先排序，附运行时 status/error |
| `/api/custom-source/toggle` | POST | `{id, enabled}` → 切换启停，重载；VM 模式脚本需管理员确认 |
| `/api/custom-source/delete` | POST | `{id}` → 删除脚本文件 + 元数据 |
| `/api/custom-source/reorder` | POST | `{sourceIds}` → 写 order.json（= 解析优先级） |

- 鉴权：公开源管理需 `x-frontend-auth: <管理员密码>`；用户源需登录 token。
- **「导入后自动启用」**：插件侧在 upload/import 成功后自动调用一次 toggle(enabled:true)。
- 文件布局：`data/users/source/_open/*.js` + `sources.json` + `order.json`。

---

## 5. 补充：lx-music-desktop v2.12.2 真实源码确认

> 工作区内发现完整源码：`D:\deepseek_harness\lx_plugin\lx-music-desktop`（Electron 应用）。

- **自定义源加载**（`src/renderer/core/useApp/useInitUserApi.ts`）：
  渲染进程通过 IPC 发送 `{requestKey, data: {source, action: 'musicUrl', info: {type, musicInfo}}}`，
  主进程在沙箱（vm2/原生 VM）执行音源脚本后返回 `{url}`；请求可取消（`userApiRequestCancel`）。
  `getMusicUrl(songInfo, type)` 返回 `{canceleFn, promise}` 结构。
- **源声明**：`sources[source] = { actions: ['musicUrl', ...], type: 'music', qualitys }` —— 与 lxserver
  的 `lx.send('inited', {sources})` 协议一致（本插件的对接假设得到确认）。
- **搜索**（`src/renderer/utils/musicSdk/{kw,wy,kg,tx,mg}/musicSearch.js`）：`musicSearch.search(name, page, limit)`
  → `{list, total}`；扩展搜索 singer/album/songList。直链（`musicInfo.js`）与音质枚举
  （`api-source-info.ts`：128k/320k/flac/wav）同 lxserver。
- **播放器内核**（`src/renderer/core/player/` + `store/player/`）：`play/pause/seek`、进度节流上报、
  列表操作 `addMusicLocationType`（队尾/下一首）—— 本插件的 PlayerState 模型与之一致。
- **重要结论**：v2.12.2 的内置直链 API 已全部禁用（`musicSdk/api-source.js` 的 `allApi` 为空），
  **直链解析 100% 依赖音源脚本**。本插件据此设计：内置搜索 SDK（五平台）+ 音源脚本引擎（node:vm），
  完全独立于 lxserver。

## 5.1 内置 SDK 移植记录（`src/sdk/`，Apache-2.0 保留来源声明）

- 从 `lx-music-desktop/src/renderer/utils/musicSdk/` 移植：`{kw,kg,tx,wy,mg}/musicSearch.js`、
  `wy/utils/{index,crypto}.js`、`tx/utils/{index,crypto}.js`、`mg/utils/`、`kg/util.js`、
  `kg/vendors/infSign.min.js`、`kw/util.js`（仅提取搜索所需 `formatSinger/objStr2JSON`）。
- 适配点：
  - 请求层重写：`src/sdk/request.ts` 用 node:http/https 实现原 `httpFetch`（needle 替代），
    接口契约不变（`{promise, canceleFn}`，body 自动 JSON 解析，gzip/deflate 解压）。
  - 公共工具 `src/sdk/utils.ts`：`toMD5/formatSingerName/decodeName/sizeFormate/formatPlayTime`
    （`decodeName` 原用 DOMParser，改为轻量 HTML 实体解码；`formatPlayTime` 自适应秒/毫秒）。
  - 平台模块仅改 import 路径，逻辑原样。
- 真实网络验证（`scripts/smoke-live.mjs`）：五平台搜索「晴天 周杰伦」均返回结果
  （含音质列表 128k/320k/flac，kg 含 flac24bit）。

## 6. 对插件的可复用结论

> 与 §5 真实源码交叉验证后结论一致。以下结论即插件实现的依据。

1. **搜索**：`GET /api/music/search`（name/singer/source/type/limit/page/pages），返回 MusicInfo 数组。
2. **直链**：`POST /api/music/url`（songInfo + quality + enableAutoSwitchApiSource），返回 `{url, type, sourceName, attempts}`；
   插件侧必须实现：10s 超时、最多 2 次重试、音质降级链（flac→320k→128k）、失败友好提示。
3. **音源管理**：完整 CRUD 走 `/api/custom-source/*`，音源优先级 = order.json（reorder 接口）。
4. **播放器状态模型**：`status/progress/duration/name/singer/picUrl/volume` + 动作
   `prev/pause/play/next/seek` —— 插件侧边栏卡片与主窗口共用此模型。
5. **播放列表**：`addMusicLocationType`（队尾/下一首）、列表增删排序语义。
6. **平台优先级（模块3 需求）**：lxserver 的「音源优先级」就是解析优先级；「平台优先级」由插件
   层实现 —— 搜索时按配置的平台顺序（如 wy→tx→kg）逐个尝试，直到某平台返回结果。
