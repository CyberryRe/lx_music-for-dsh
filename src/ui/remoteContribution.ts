// lxPlayback 的 Typert client 面（TYPERT contribution）。
// dsh 的 client 端 `remote.<namespace>` 服务由 ctx.remote.$mount(contribution) 生成，
// 官方由 dsh-typert-generator 从 FaceModel 生成（不随 npm 分发）；本插件手写同构面，
// host 端 PlaybackService 走 gateway 的 SRC fallback（TypertRemoteService + @Remote），
// 参数/结果均为 src-json 宽松校验，因此这里 schema 只需对齐 wire 字段名与基本形状。
//
// 注意：client 插件必须在自己的 apply 里先 $mount 本面，再访问 ctx.remote.lxPlayback；
// 不能在 inject 里声明 'remote.lxPlayback'（自己等自己提供的服务会死锁）。
//
// 参数约定：wire 层按 descriptor.parameters 逐位解析，缺失参数即拒绝
// （"rejected <param>"）。因此所有带可选值的 Remote 方法统一为**单个必填对象参数**
// （字段可省略，JSON 内部不做 wire 校验），与 host 端 @Remote 方法签名一一对应。

import { z } from 'zod'

/** 宽松 JSON 对象（业务结构不在此拦截，host SRC 端也只做 JSON 安全校验）。 */
const looseObject = () => z.object({}).passthrough()

/** 结果 schema：host 端返回裸业务值（PlaybackService 方法返回值），
 *  wire 上的 answered 包装由连接层剥掉；client 端 decode 的对象就是业务值本身。
 *  用宽松 unknown 避免与具体类型漂移（host SRC 端也只做 JSON 安全校验）。 */
const businessResult = z.unknown()

interface JsonParam {
  name: string
  wire: string
  source: 'json'
  codec: { mode: 'strict'; typeSymbol: string; schema: z.ZodType }
}

/** 位置参数 → wire 字段（name/wire 必须与 host 方法参数名一致）。 */
const jsonParam = (name: string, schema: z.ZodType): JsonParam => ({
  name,
  wire: name,
  source: 'json',
  codec: {
    mode: 'strict',
    typeSymbol: `lx-music-for-dsh#lxPlayback/${name}`,
    schema,
  },
})

interface Descriptor {
  id: string
  service: string
  namespace: string
  method: string
  invocation: { kind: 'direct' }
  parameters: JsonParam[]
  result: { mode: 'strict'; typeSymbol: string; schema: z.ZodType }
  sourceLocation: { file: string; line: number; column: number }
}

const desc = (method: string, parameters: JsonParam[] = []): Descriptor => ({
  id: `lx-music-for-dsh#lxPlayback/${method}`,
  service: 'lxPlayback',
  namespace: 'lxPlayback',
  method,
  invocation: { kind: 'direct' },
  parameters,
  result: {
    mode: 'strict',
    typeSymbol: `lx-music-for-dsh#lxPlayback/${method}:result`,
    schema: businessResult,
  },
  sourceLocation: { file: 'src/playback.ts', line: 1, column: 1 },
})

/** lxPlayback remote 贡献：与 PlaybackService 的 @Remote 方法一一对应。
 *  注意：可选值一律收敛进必填对象参数（play({index})、resolveUrl({music, quality?})、
 *  importSource({url, filename?})、getLogs({limit?})），避免 wire 拒绝缺失参数。 */
export const LXP_REMOTE_CONTRIBUTION = {
  package: 'lx-music-for-dsh',
  descriptors: [
    // 状态查询
    desc('getState'),
    desc('getSettings'),
    desc('saveSettings', [jsonParam('partial', looseObject())]),
    desc('getProviderMode'),
    // 播放控制
    desc('play', [jsonParam('req', looseObject())]),
    desc('pause'),
    desc('toggle'),
    desc('next'),
    desc('prev'),
    desc('seek', [jsonParam('seconds', z.number())]),
    desc('setVolume', [jsonParam('volume', z.number())]),
    desc('setMute', [jsonParam('mute', z.boolean())]),
    desc('setQuality', [jsonParam('quality', z.string())]),
    desc('setPlayMode', [jsonParam('mode', z.string())]),
    desc('reportProgress', [
      jsonParam('p', z.object({ progress: z.number(), duration: z.number(), status: z.string() }).passthrough()),
    ]),
    // 播放列表管理
    desc('addMusic', [jsonParam('musics', z.array(z.unknown())), jsonParam('position', z.enum(['tail', 'next']))]),
    desc('removeMusic', [jsonParam('id', z.string())]),
    desc('clearList'),
    desc('reorderList', [jsonParam('ids', z.array(z.string()))]),
    desc('exportList'),
    // 搜索与直链
    desc('search', [jsonParam('req', looseObject())]),
    desc('resolveUrl', [jsonParam('req', looseObject())]),
    // 音源管理
    desc('listSources'),
    desc('validateSource', [jsonParam('script', z.string())]),
    desc('uploadSource', [jsonParam('filename', z.string()), jsonParam('content', z.string())]),
    desc('importSource', [jsonParam('req', looseObject())]),
    desc('toggleSource', [jsonParam('id', z.string()), jsonParam('enabled', z.boolean())]),
    desc('deleteSource', [jsonParam('id', z.string())]),
    desc('reorderSources', [jsonParam('ids', z.array(z.string()))]),
    // 日志
    desc('getLogs', [jsonParam('req', looseObject())]),
  ],
}
