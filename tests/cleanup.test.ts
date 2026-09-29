// 本地数据清理的回归测试。
//
// 两条路径都要锁：
//   1. 用户显式「彻底清除本地数据」——删画像/日志（facade.clear）+ 域外遗留文件；
//   2. 插件**卸载**时自动清理——但必须"延迟 + 可取消"，因为 DSH 升级插件同样是
//      "卸载旧包 → 安装新包"，无脑立刻删会让用户每次升级都丢播放列表与画像。

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from './mini'
import { cancelPendingCleanup, cleanupLocalData, hasPendingCleanup, localDataPaths, scheduleCleanup } from '../src/storage/cleanup'

/** 造一个"装着本插件全部本地数据"的假 DSH_HOME。 */
function makeHome(): { home: string; env: NodeJS.ProcessEnv; domainFile: string } {
  const home = mkdtempSync(join(tmpdir(), 'lx-cleanup-'))
  const storages = join(home, 'storages')
  mkdirSync(join(storages, 'lx_music', 'taste_tracks'), { recursive: true })
  writeFileSync(join(storages, 'lx_music', 'global.json'), JSON.stringify({ playlist: [{ id: 'x' }] }))
  writeFileSync(join(storages, 'lx_music', 'taste_tracks', 'a.json'), '{}')
  writeFileSync(join(storages, 'lx_music.json.migrated-1'), '{"legacy":true}')
  writeFileSync(join(storages, 'lx-music-sources.json'), '{"records":[]}')
  writeFileSync(join(storages, 'lx-music-sources.json.migrated-2'), '{}')
  writeFileSync(join(home, 'lx-music-plugin-status.json'), '{}')
  return { home, env: { DSH_HOME: home } as NodeJS.ProcessEnv, domainFile: join(storages, 'lx_music.json') }
}

describe('本地数据清理', () => {
  it('枚举出插件写过的全部路径（域目录 + 旧文件/搁置副本 + 音源兜底 + 状态文件）', () => {
    const { home, env } = makeHome()
    try {
      const paths = localDataPaths(env).map((p) => p.replace(home, ''))
      expect(paths.some((p) => p.endsWith(join('storages', 'lx_music')))).toBe(true)
      expect(paths.some((p) => p.includes('lx_music.json.migrated-1'))).toBe(true)
      expect(paths.some((p) => p.includes('lx-music-sources.json'))).toBe(true)
      expect(paths.some((p) => p.includes('lx-music-sources.json.migrated-2'))).toBe(true)
      expect(paths.some((p) => p.includes('lx-music-plugin-status.json'))).toBe(true)
      // 绝不误伤别的插件/DSH 自己的数据
      expect(paths.some((p) => p.includes('workspace.json'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('cleanupLocalData 删除全部（含域目录）：播放列表/画像/日志/音源一概不留', () => {
    const { home, env } = makeHome()
    try {
      const result = cleanupLocalData({ source: env })
      expect(result.failed).toEqual([])
      expect(result.removed.length).toBeGreaterThanOrEqual(5)
      expect(existsSync(join(home, 'storages', 'lx_music'))).toBe(false)
      expect(existsSync(join(home, 'lx-music-plugin-status.json'))).toBe(false)
      expect(existsSync(join(home, 'storages', 'lx-music-sources.json'))).toBe(false)
      // 幂等：再删一次不报错、也不误报
      expect(cleanupLocalData({ source: env }).failed).toEqual([])
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('includeDomain=false 时保留域目录（UI 里 domain 正开着，只能清域外遗留）', () => {
    const { home, env } = makeHome()
    try {
      const result = cleanupLocalData({ source: env, includeDomain: false })
      expect(result.removed.length).toBeGreaterThanOrEqual(3)
      expect(existsSync(join(home, 'storages', 'lx_music'))).toBe(true) // 域目录保留
      expect(existsSync(join(home, 'storages', 'lx_music.json.migrated-1'))).toBe(false) // 域外遗留清掉
      expect(existsSync(join(home, 'lx-music-plugin-status.json'))).toBe(false)
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('卸载清理是延迟的，并且"重新激活"会取消它（升级不丢数据）', async () => {
    const { home } = makeHome()
    try {
      let done = false
      scheduleCleanup({ delayMs: 30, onDone: () => void (done = true) })
      expect(hasPendingCleanup()).toBe(true)
      // 模拟升级：新版本在窗口内重新激活 → 取消
      expect(cancelPendingCleanup()).toBe(true)
      expect(hasPendingCleanup()).toBe(false)
      await new Promise((r) => setTimeout(r, 60))
      expect(done).toBe(false)
      expect(existsSync(join(home, 'storages', 'lx_music'))).toBe(true) // 数据还在
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('真的卸载（没人取消）时按延迟执行清理', async () => {
    const { home } = makeHome()
    try {
      const previous = process.env.DSH_HOME
      process.env.DSH_HOME = home
      try {
        let removed = -1
        scheduleCleanup({ delayMs: 20, onDone: (r) => void (removed = r.removed.length) })
        await new Promise((r) => setTimeout(r, 80))
        expect(removed).toBeGreaterThanOrEqual(5)
        expect(existsSync(join(home, 'storages', 'lx_music'))).toBe(false)
      } finally {
        if (previous === undefined) delete process.env.DSH_HOME
        else process.env.DSH_HOME = previous
      }
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('安装/更新提示（需要彻底重启 DSH）', () => {
  it('客户端卡片在未连接时给出"彻底重启 DSH"的提示（host 挂了也看得见）', async () => {
    const { readFileSync } = await import('node:fs')
    const card = readFileSync(join(__dirname, '..', '..', 'src', 'ui', 'Card.tsx'), 'utf8')
    expect(card).toContain('彻底退出并重启 DSH')
    expect(card).toContain('RESTART_HINT')
  })

  it('插件列表里的描述带提示（DSH 渲染 description，报错栏改不了时的兜底）', async () => {
    const { readFileSync } = await import('node:fs')
    const manifest = JSON.parse(readFileSync(join(__dirname, '..', '..', 'manifest.json'), 'utf8')) as { description: string }
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8')) as { description: string }
    expect(manifest.description).toContain('彻底退出并重启 DSH')
    expect(manifest.description).toContain('下个大版本修复')
    expect(pkg.description).toContain('彻底退出并重启 DSH')
  })

  it('apply 抛出的错自带该提示（这样 DSH 报错栏里能看到）', async () => {
    const { readFileSync } = await import('node:fs')
    const src = readFileSync(join(__dirname, '..', '..', 'src', 'index.ts'), 'utf8')
    expect(src).toContain('ACTIVATION_HINT')
    expect(src).toContain('彻底退出并重启 DSH')
  })
})
