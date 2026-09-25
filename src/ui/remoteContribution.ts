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
//
// 本文件用 `import type` 直接引用 @deepseek-ai/dsh-typert-protocol 的真实协议类型，
// 因此这套手写 descriptor 的形状由 `tsc` 对着 DSH 的 .d.ts 校验 —— 协议漂移会在
// 类型检查阶段暴露，而不是等到浏览器里 $mount 失败。

import { z } from 'zod'
import type {
  InvocationDescriptor,
  InvocationParameterDescriptor,
  TypertCodec,
  TypertRemoteContribution,
  TypertSchema,
} from '@deepseek-ai/dsh-typert-protocol'

/** 宽松 JSON 对象（业务结构不在此拦截，host SRC 端也只做 JSON 安全校验）。 */
const looseObject = (): z.ZodType => z.object({}).passthrough()

/** strict codec 的 0.1.7 形状（协议类型）。 */
type StrictTypertCodec = Extract<TypertCodec, { mode: 'strict' }>
/** 0.1.5 形状：`schema` 字段在 0.1.7 已被移除，但保留它才能让同一份产物兼容两个版本。 */
type LegacyStrictCodec = { readonly schema: TypertSchema }
/** 双契约 codec：0.1.5 读 `schema`、0.1.7 读 `create()`，互为超集、互不读取对方字段。 */
type DualStrictCodec = StrictTypertCodec & LegacyStrictCodec

/**
 * 构造一个**同时兼容 DSH 0.1.5 与 0.1.7** 的 strict codec。
 *
 * 两个版本的契约正好互补（都是"校验某字段存在 + 用它 parse"）：
 *
 * | | 0.1.5 | 0.1.7 |
 * |---|---|---|
 * | 校验 | `typeof codec.schema.parse === 'function'` | `typeof codec.create === 'function'` |
 * | 解码 | `codec.schema.parse(v)` | `codec.create().parse(v)` |
 *
 * 把两个字段**同时**放上去，同一份 bundle 在两个运行时上都能通过校验并正确解码
 * （双方都只读自己那一个字段，多出来的字段不会被拒绝）。这样插件就不再需要"按 DSH
 * 版本配对安装"，`latest` 对任何人都安全。
 *
 * 代价：`schema` 必须**立即**物化（0.1.5 直接读它，无法懒加载）；`create()` 复用同一实例。
 */
const strictCodec = (typeSymbol: string, build: () => z.ZodType): DualStrictCodec => {
  const schema = build() as TypertSchema
  return {
    mode: 'strict',
    typeSymbol,
    schema,
    create: () => schema,
  }
}

/** 位置参数 → wire 字段（name/wire 必须与 host 方法参数名一致）。 */
const jsonParam = (name: string, build: () => z.ZodType): InvocationParameterDescriptor => ({
  name,
  wire: name,
  source: 'json',
  codec: strictCodec(`lx-music-for-dsh#lxPlayback/${name}`, build),
})

const desc = (method: string, parameters: InvocationParameterDescriptor[] = []): InvocationDescriptor => ({
  id: `lx-music-for-dsh#lxPlayback/${method}`,
  service: 'lxPlayback',
  namespace: 'lxPlayback',
  method,
  invocation: { kind: 'direct' },
  parameters,
  // host 端返回裸业务值（PlaybackService 方法返回值），wire 上的 answered 包装由连接层
  // 剥掉；client 端 decode 的对象就是业务值本身。用 unknown 避免与具体类型漂移
  // （host SRC 端也只做 JSON 安全校验）。
  result: strictCodec(`lx-music-for-dsh#lxPlayback/${method}:result`, () => z.unknown()),
  sourceLocation: { file: 'src/playback.ts', line: 1, column: 1 },
})

/** lxPlayback remote 贡献：与 PlaybackService 的 @Remote 方法一一对应。
 *  注意：可选值一律收敛进必填对象参数（play({index})、resolveUrl({music, quality?})、
 *  importSource({url, filename?})、getLogs({limit?})），避免 wire 拒绝缺失参数。 */
export const LXP_REMOTE_CONTRIBUTION: TypertRemoteContribution = {
  package: 'lx-music-for-dsh',
  descriptors: [
    // 状态查询
    desc('getState'),
    desc('getSettings'),
    desc('saveSettings', [jsonParam('partial', looseObject)]),
    desc('getProviderMode'),
    // 播放控制
    desc('play', [jsonParam('req', looseObject)]),
    desc('pause'),
    desc('toggle'),
    desc('next'),
    desc('prev'),
    desc('seek', [jsonParam('seconds', () => z.number())]),
    desc('setVolume', [jsonParam('volume', () => z.number())]),
    desc('setMute', [jsonParam('mute', () => z.boolean())]),
    desc('setQuality', [jsonParam('quality', () => z.string())]),
    desc('setPlayMode', [jsonParam('mode', () => z.string())]),
    desc('reportProgress', [
      jsonParam('p', () => z.object({ progress: z.number(), duration: z.number(), status: z.string() }).passthrough()),
    ]),
    // 播放列表管理
    desc('addMusic', [jsonParam('musics', () => z.array(z.unknown())), jsonParam('position', () => z.enum(['tail', 'next']))]),
    desc('removeMusic', [jsonParam('id', () => z.string())]),
    desc('clearList'),
    desc('reorderList', [jsonParam('ids', () => z.array(z.string()))]),
    desc('exportList'),
    // 搜索与直链
    desc('search', [jsonParam('req', looseObject)]),
    desc('resolveUrl', [jsonParam('req', looseObject)]),
    // 音源管理
    desc('listSources'),
    desc('validateSource', [jsonParam('script', () => z.string())]),
    desc('uploadSource', [jsonParam('filename', () => z.string()), jsonParam('content', () => z.string())]),
    desc('importSource', [jsonParam('req', looseObject)]),
    desc('toggleSource', [jsonParam('id', () => z.string()), jsonParam('enabled', () => z.boolean())]),
    desc('deleteSource', [jsonParam('id', () => z.string())]),
    desc('reorderSources', [jsonParam('ids', () => z.array(z.string()))]),
    // 日志
    desc('getLogs', [jsonParam('req', looseObject)]),
  ],
}
