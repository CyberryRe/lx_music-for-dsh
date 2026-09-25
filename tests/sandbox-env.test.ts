// 音源脚本子进程的环境构造测试。
//
// 背景（1.0.3 修的一个真实故障）：桌面版（dsh-desktop）的插件跑在 **Electron 主进程**里，
// 此时 `process.execPath` 是 Electron 主程序而非 node。原来的实现直接
// `spawn(process.execPath, [runner])`，于是又起了一个 GUI 实例，撞上单实例锁后立刻以
// **code=0** 退出，用户看到的是：
//
//     校验失败：音源 temp_validate 子进程在初始化期间退出（code=0）
//     导入失败：音源 xxx.js 子进程在初始化期间退出（code=0）
//
// 修法是给子进程注入 `ELECTRON_RUN_AS_NODE=1`（DSH 自己起内部 Node 脚本也用这一招）。
// 同时这里锁定"环境白名单"的安全边界：子进程不得拿到宿主的任何机密。

import { describe, expect, it } from './mini'
import { buildChildEnv } from '../src/engine/sandbox'

describe('音源子进程环境（buildChildEnv）', () => {
  it('Electron 宿主（桌面版）注入 ELECTRON_RUN_AS_NODE=1', () => {
    const env = buildChildEnv(true, { NODE_ENV: 'production', SystemRoot: 'C:\\Windows' })
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })

  it('纯 Node 宿主（dsh web CLI）不注入该变量', () => {
    const env = buildChildEnv(false, { NODE_ENV: 'production', SystemRoot: 'C:\\Windows' })
    expect('ELECTRON_RUN_AS_NODE' in env).toBe(false)
  })

  it('只透传白名单变量，不泄漏宿主机密', () => {
    const env = buildChildEnv(true, {
      NODE_ENV: 'production',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\Temp',
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      // 以下都不得出现在子进程环境里
      GITHUB_TOKEN: 'gho_secret',
      DSH_SESSION_ID: 'session-secret',
      OPENAI_API_KEY: 'sk-secret',
      USERPROFILE: 'C:\\Users\\someone',
    })
    expect(env.SystemRoot).toBe('C:\\Windows')
    expect(env.TEMP).toBe('C:\\Temp')
    expect(env.HTTPS_PROXY).toBe('http://127.0.0.1:7897')
    expect(env.NODE_ENV).toBe('production')
    expect('GITHUB_TOKEN' in env).toBe(false)
    expect('DSH_SESSION_ID' in env).toBe(false)
    expect('OPENAI_API_KEY' in env).toBe(false)
    expect('USERPROFILE' in env).toBe(false)
  })

  it('缺省 NODE_ENV 时回退 production', () => {
    const env = buildChildEnv(true, {})
    expect(env.NODE_ENV).toBe('production')
    expect(env.ELECTRON_RUN_AS_NODE).toBe('1')
  })
})
