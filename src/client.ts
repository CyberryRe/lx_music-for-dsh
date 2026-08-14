// lx-music-for-dsh 插件 client 入口。
// 注入 sidebar.footer.action 迷你卡片（设置上方），并管理主窗口/设置窗口。
// 与 host 通过 Typert Remote（ctx.remote.lxPlayback.*）通信，状态轮询同步。

import type { LxRemote } from './ui/store'
import { LxStore } from './ui/store'
import { LxMusicCard } from './ui/Card'
import { WindowsHost } from './ui/WindowsHost'
import { CSS, STYLE_TAG } from './ui/styles'
import { LXP_REMOTE_CONTRIBUTION } from './ui/remoteContribution'

const NS = 'lxMusic'

const zh = {
  'card.playlist': '播放列表',
  'card.settings': '设置',
}

const en = {
  'card.playlist': 'Playlist',
  'card.settings': 'Settings',
}

// remote.<namespace> 服务由 ctx.remote.$mount(contribution) 生成（官方由 typert-generator
// 产出；本插件在 apply 中手写挂载，见 ./ui/remoteContribution）。因此这里不能把
// 'remote.lxPlayback' 写进 inject —— 那是自己等自己提供的服务，会永远 pending；
// 正确顺序是：注入 'remote'（$mount 所在服务）→ apply 里先 $mount 再使用。
export const inject = ['slots', 'locale', 'remote']

interface Answered {
  ok: boolean
  value?: unknown
  error?: { code: string; message: string }
}

/** 把 remote 调用收敛为直接返回：answered 包装（{ok, value|error}）解包，
 *  裸业务值直接透传（host 端返回裸值、wire 包装由连接层剥掉的形态）。 */
function makeRemote(namespaceService: unknown): LxRemote {
  const service = namespaceService as Record<string, (...args: unknown[]) => Promise<unknown>>
  const proxy = new Proxy({} as LxRemote, {
    get: (_t, prop: string) => {
      if (prop === 'then') return undefined
      return (...args: unknown[]) => {
        const fn = service[prop]
        if (typeof fn !== 'function') return Promise.reject(new Error(`remote method ${prop} unavailable`))
        return fn(...args).then((res) => {
          if (res && typeof res === 'object' && 'ok' in (res as Record<string, unknown>)) {
            const answered = res as Answered
            if (!answered.ok) {
              throw new Error(`${answered.error?.message ?? '调用失败'} (${answered.error?.code ?? 'error'})`)
            }
            return answered.value
          }
          return res
        })
      }
    },
  })
  return proxy
}

export async function apply(ctx: {
  effect?(fn: () => void | (() => void), label?: string): void
  locale?: { register(ns: string, dicts: Record<string, Record<string, string>>): void }
  slots?: {
    inject(slot: string, fn: () => unknown): void
    register(opts: unknown, component: unknown): unknown
  }
  remote?: { $mount(contribution: unknown): Promise<unknown>; lxPlayback?: unknown }
  get?(name: string): unknown
}): Promise<void> {
  // 先挂载 lxPlayback 的 remote 面，再取服务。
  // 注意：$mount 由当前 fiber provide 服务，而 `ctx.remote.lxPlayback` 属性读取
  // 受 cordis 的 inject 守卫拦截（自己 inject 自己会死锁，不 inject 读不了）；
  // 因此用 ctx.get('remote.lxPlayback') 直接读全局 store（绕过守卫）。
  let remoteService: unknown = undefined
  if (ctx.remote?.$mount) {
    await ctx.remote.$mount(LXP_REMOTE_CONTRIBUTION)
    remoteService = ctx.get?.('remote.lxPlayback')
    if (typeof console !== 'undefined' && remoteService === undefined) {
      console.warn('[lx-music-for-dsh] $mount 完成但 remote.lxPlayback 不在 store，remote keys:', Object.keys(ctx.remote))
    }
  }

  if (ctx.effect) {
    ctx.effect(() => ctx.locale?.register(NS, { zh, en }), 'lx-music: dictionaries')
  }

  // 注入 CSS（幂等）
  if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${STYLE_TAG}"]`) === null) {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'lx-music-for-dsh'
    tag.dataset.pluginCss = STYLE_TAG
    tag.textContent = CSS
    document.head.appendChild(tag)
  }

  const remote = makeRemote(remoteService)
  const store = new LxStore(remote)

  if (ctx.effect) {
    ctx.effect(() => {
      store.start()
      return () => store.dispose()
    }, 'lx-music: store lifecycle')
  } else {
    store.start()
  }

  if (ctx.slots) {
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots!.register({
        name: 'sidebar.footer.action',
        id: 'lx-music-card',
        locale: NS,
        inject: () => ({ store }),
      }, LxMusicCard),
    )
    // 窗口宿主与卡片共享同一 store（侧边栏 footer.action 为 list 槽，可并列多个注册者）
    ctx.slots.inject('sidebar.footer.action', () =>
      ctx.slots!.register({
        name: 'sidebar.footer.action',
        id: 'lx-music-windows',
        locale: NS,
        inject: () => ({ store }),
      }, WindowsHost),
    )
  }
}
