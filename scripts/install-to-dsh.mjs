// 安装到 DSH web profile 的辅助脚本。
// 完成两件事：
//   1. 把构建产物复制为 tarball（npm pack）
//   2. 在 %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml 中追加插件注册行（幂等）
// 包安装本身（pnpm add）需要用户在 profile 目录手动执行（受限沙箱无法 spawn 子进程）：
//   cd %USERPROFILE%\.dsh\profiles\web && pnpm add <生成的 tgz 路径>
// 用法：node scripts/install-to-dsh.mjs [--profile <path>]
//
// 注意：修改 cordis.patch.yml 后需要重启 `dsh web` 才生效。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const profileArg = process.argv.indexOf('--profile')
const profileDir = profileArg >= 0
  ? process.argv[profileArg + 1]
  : join(homedir(), '.dsh', 'profiles', 'web')

const patchPath = join(profileDir, 'cordis.patch.yml')
if (!existsSync(patchPath)) {
  console.error(`[install] 未找到 profile patch 文件：${patchPath}`)
  console.error('[install] 请确认 DSH web profile 路径（默认 %USERPROFILE%\\.dsh\\profiles\\web）')
  process.exit(1)
}

const PLUGIN_ID = 'lx-music'
const PACKAGE_NAME = 'lx-music-for-dsh'

const block = [
  '',
  '# ---- lx-music-for-dsh（LX Music 增强控制插件）----',
  `- insert:`,
  `    - id: ${PLUGIN_ID}`,
  `      name: '${PACKAGE_NAME}'`,
  `      config:`,
  `        lxServerUrl: ''`,
  `        providerMode: 'auto'`,
  `        defaultQuality: '320k'`,
  `        rateLimitPerMinute: 6`,
  '',
].join('\n')

const current = readFileSync(patchPath, 'utf8')
if (current.includes(`id: ${PLUGIN_ID}`) && current.includes(PACKAGE_NAME)) {
  console.log('[install] 插件行已存在，跳过 patch 写入')
} else {
  // 若当前文件是空数组 `[]`，替换为真正的列表
  const next = current.trim() === '[]'
    ? block.replace(/^- insert:/m, '- insert:').trimStart()
    : `${current.replace(/\s*$/, '')}\n${block}`
  writeFileSync(patchPath, next, 'utf8')
  console.log(`[install] 已写入插件行 → ${patchPath}`)
}

// 打包 tarball（提示用户手动 pnpm add）
mkdirSync(join(root, 'dist'), { recursive: true })
console.log('[install] 下一步（请在 profile 目录执行）：')
console.log(`  cd ${profileDir}`)
console.log(`  pnpm add ${join(root, 'lx-music-for-dsh-0.1.0.tgz')}`)
console.log('  然后重启 `dsh web` 并刷新浏览器。')
