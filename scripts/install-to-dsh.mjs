// 一条命令安装到 DSH profile（web 模式）。
//
// 从 @deepseek-ai/dsh 0.1.5-rc.1 起，插件包可以用 `dsh.bundle.patch` 声明自己是一个
// profile 组合层：`dsh plugin --profile <name> add <tgz|包名>` 会把它追加进 profile
// 的 `dsh.profile.bundles`，包内 cordis.patch.yml 的插件行随之自动生效 —— 不再需要
// 手工编辑 profile 的 cordis.patch.yml（0.1.0-rc.6 时代的做法，已废弃）。
//
// 用法：
//   node scripts/install-to-dsh.mjs [--profile web] [--dry-run] [--no-prune]
//
// 迁移：旧版本是手工在 profile 的 cordis.patch.yml 里 insert 一条 `id: lx-music` 行。
// 现在该行由包内 bundle patch 提供，若旧行还在，cordis 会以
// "duplicate loader entry id: lx-music" 直接拒绝启动整个 dsh。本脚本会自动删除这条
// 遗留行（先备份为 cordis.patch.yml.bak-<时间戳>）；`--no-prune` 只提示不修改。
//
// 前置：全局 `dsh`（0.1.5-rc.1 或更新）与 `pnpm` 在 PATH 上。
// 安装后需要重启 `dsh web` 并刷新浏览器 —— host 侧代码（lib/index.js）在进程启动时加载。

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const PACKAGE_NAME = 'lx-music-for-dsh'
const PLUGIN_ID = 'lx-music'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const dryRun = process.argv.includes('--dry-run')
const prune = !process.argv.includes('--no-prune')
const profileArg = process.argv.indexOf('--profile')
const profileName = profileArg >= 0 ? process.argv[profileArg + 1] : 'web'
const profileDir = join(homedir(), '.dsh', 'profiles', profileName)

function run(command, args) {
  const shown = [command, ...args].join(' ')
  if (dryRun) {
    console.log(`[install] (dry-run) ${shown}`)
    return { status: 0 }
  }
  console.log(`[install] $ ${shown}`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error !== undefined) {
    console.error(`[install] 无法执行 ${command}: ${result.error.message}`)
    process.exit(1)
  }
  return result
}

/**
 * Remove the pre-0.1.5 manual `insert` row for this plugin from a profile patch
 * file, keeping every unrelated entry intact. The file is a top-level YAML array;
 * we slice it by top-level `- ` entries and by list items inside `- insert:`.
 * @param patchPath - absolute path of the profile's cordis.patch.yml.
 * @returns a human-readable summary of what happened.
 */
function pruneLegacyRow(patchPath) {
  const raw = readFileSync(patchPath, 'utf8')
  const lines = raw.split(/\r?\n/)
  const isTopLevel = (line) => /^-\s/.test(line)
  const itemRe = /^(\s+)-\s+id:\s*['"]?([\w.-]+)['"]?\s*$/

  const entries = []
  for (let i = 0; i < lines.length; i++) {
    if (isTopLevel(lines[i])) entries.push({ start: i, end: lines.length })
  }
  for (let i = 0; i < entries.length; i++) {
    if (i + 1 < entries.length) entries[i].end = entries[i + 1].start
  }

  const drop = []
  let found = false
  for (const entry of entries) {
    if (!/^-\s+insert:\s*$/.test(lines[entry.start])) continue
    const itemStarts = []
    for (let i = entry.start + 1; i < entry.end; i++) {
      const m = itemRe.exec(lines[i])
      if (m !== null) itemStarts.push({ index: i, id: m[2] })
    }
    const target = itemStarts.findIndex((item) => item.id === PLUGIN_ID)
    if (target === -1) continue
    found = true
    if (itemStarts.length === 1) {
      // Sole item: drop the whole top-level `- insert:` entry.
      drop.push([entry.start, entry.end])
    } else {
      const from = itemStarts[target].index
      const to = target + 1 < itemStarts.length ? itemStarts[target + 1].index : entry.end
      drop.push([from, to])
    }
  }
  if (!found) return { found: false, changed: false }
  // A top-level override row (`- id: lx-music`) is NOT a duplicate: it replaces the
  // bundle layer's config by id and is the documented way to configure the plugin.
  // It may coexist with a legacy insert row, which still has to go.
  const hasOverride = entries.some((entry) => /^-\s+id:\s*['"]?lx-music['"]?\s*$/.test(lines[entry.start]))
  if (!prune) return { found: true, changed: false, override: hasOverride }

  const kept = []
  for (let i = 0; i < lines.length; i++) {
    if (drop.some(([from, to]) => i >= from && i < to)) continue
    kept.push(lines[i])
  }
  // Collapse the blank runs left behind by the removal.
  const out = kept.join('\n').replace(/\n{3,}/g, '\n\n')
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')
  const backup = `${patchPath}.bak-${stamp}`
  copyFileSync(patchPath, backup)
  writeFileSync(patchPath, out, 'utf8')
  return { found: true, changed: true, backup, override: hasOverride }
}

// 1. 打包（npm pack 会先跑 prepare → node scripts/build.mjs）。
mkdirSync(join(root, 'dist'), { recursive: true })
const packed = run('npm', ['pack', '--pack-destination', join(root, 'dist')])
if (packed.status !== 0) {
  console.error('[install] npm pack 失败')
  process.exit(packed.status ?? 1)
}
const tarball = join(root, 'dist', `${PACKAGE_NAME}-${pkg.version}.tgz`)
if (!dryRun && !existsSync(tarball)) {
  console.error(`[install] 未找到打包产物：${tarball}`)
  process.exit(1)
}

// 2. 迁移：先清掉会与 bundle 层撞 id 的遗留手工行，否则 dsh 启动即失败。
const patchPath = join(profileDir, 'cordis.patch.yml')
if (existsSync(patchPath) && !dryRun) {
  const result = pruneLegacyRow(patchPath)
  if (result.changed) {
    console.log(`[install] 已删除遗留的手工插件行 (id: ${PLUGIN_ID})，备份：${result.backup}`)
    if (result.override === true) {
      console.log(`[install] 保留了同 id 的配置覆盖行（它按 id 覆盖 bundle 层配置）`)
    }
  } else if (result.found) {
    console.error(`[install] ⚠ ${patchPath} 里仍有与 bundle 层重复的手工 insert 行 (id: ${PLUGIN_ID})。`)
    console.error('[install]   dsh 会以 "duplicate loader entry id: lx-music" 拒绝启动；请手工删除该行后重跑（不要加 --no-prune）。')
  } else if (result.override === true) {
    console.log(`[install] 检测到 id: ${PLUGIN_ID} 的配置覆盖行（保留，它按 id 覆盖 bundle 层配置）`)
  }
}

// 3. 安装进 profile：pnpm 落到 profile 的 node_modules，dsh 再把声明了
//    dsh.bundle 的依赖追加到 dsh.profile.bundles（组合层）。
//
//    先 remove 再 add 是必需的，不是保险：pnpm 把 `file:` tarball 当不可变依赖，
//    同一个版本号重新打包后，`add` 会认为依赖已满足而沿用旧副本（`--force` 也不行），
//    开发循环会静默装到过期代码。remove 同时也让 dsh 把包移出 bundles，再由 add 重新加入。
const profileManifestForRemove = join(profileDir, 'package.json')
const alreadyInstalled = existsSync(profileManifestForRemove) &&
  Object.keys(JSON.parse(readFileSync(profileManifestForRemove, 'utf8')).dependencies ?? {}).includes(PACKAGE_NAME)
if (alreadyInstalled) {
  const removed = run('dsh', ['plugin', '--profile', profileName, 'remove', PACKAGE_NAME])
  if (removed.status !== 0) {
    console.error(`[install] dsh plugin remove ${PACKAGE_NAME} 失败`)
    process.exit(removed.status ?? 1)
  }
}
const install = run('dsh', ['plugin', '--profile', profileName, 'add', tarball])
if (install.status !== 0) {
  console.error('[install] dsh plugin add 失败')
  process.exit(install.status ?? 1)
}

if (dryRun) {
  console.log('[install] dry-run 结束')
  process.exit(0)
}

// 4. 校验：包是否真的成为了组合层。
let ok = true
const profileManifestPath = join(profileDir, 'package.json')
if (!existsSync(profileManifestPath)) {
  console.error(`[install] 未找到 profile：${profileManifestPath}`)
  ok = false
} else {
  const manifest = JSON.parse(readFileSync(profileManifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  const deps = Object.keys(manifest.dependencies ?? {})
  if (!deps.includes(PACKAGE_NAME)) {
    console.error(`[install] profile dependencies 里没有 ${PACKAGE_NAME}`)
    ok = false
  }
  if (bundles.includes(PACKAGE_NAME)) {
    console.log(`[install] ✓ ${PACKAGE_NAME} 已作为组合层装载（dsh.profile.bundles）`)
  } else {
    console.error('[install] ✗ 包未进入 dsh.profile.bundles —— 插件行不会生效')
    console.error('[install]   请确认安装的版本声明了 dsh.bundle.patch，且 dsh >= 0.1.5-rc.1')
    ok = false
  }
}

console.log(`[install] 下一步：重启 \`dsh ${profileName}\`（host 侧生效），然后刷新浏览器页面。`)
process.exit(ok ? 0 : 1)
