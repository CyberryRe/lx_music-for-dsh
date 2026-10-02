// 工作区清理：删除构建残留与散落的历史打包产物。
//
// 背景：仓库根目录曾出现 `.npm-cache/`（npm 的 cache 被写进了仓库）、`.test-dist/`
// （测试编译产物）、`dist/*.tgz`（历史打包产物）以及根下散落的 `.tgz`。
// 这些都已经在 `.gitignore` 里（`.npm-cache/`、`.test-dist/`、`dist/`、`lib/`），
// 所以本脚本只负责**把已经躺在磁盘上的那些删掉**。
//
// ⚠️ 本脚本**不碰 `.gitignore`**。曾经它试图"修复 .gitignore 编码"，那是基于一次错误的
// 诊断（把工具读不出文件误判成 UTF-16）：真实情况是该文件本来就是合法 UTF-8，
// 而"重写"只会给它加上 BOM、并把中文注释写成乱码 —— 已经因此弄脏过一次工作区。
// 编码问题要么不存在、要么用编辑器确认后再手工处理，不要交给脚本猜。
//
// 用法：
//   node scripts/clean-workspace.mjs            # 删除缓存与构建残留
//   node scripts/clean-workspace.mjs --dry-run  # 只报告会删什么
//   node scripts/clean-workspace.mjs --keep-dist          # 保留 dist/ 里的历史 tgz
//   node scripts/clean-workspace.mjs --with-node-modules  # 连 node_modules 一起删（需重装依赖）
//
// 安全性：所有删除目标都先解析成绝对路径并校验仍在仓库根目录内，越界直接跳过并报错。

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(dirname(fileURLToPath(import.meta.url))))
const dryRun = process.argv.includes('--dry-run')
const keepDist = process.argv.includes('--keep-dist')
const withNodeModules = process.argv.includes('--with-node-modules')

const removed = []
const skipped = []
const failed = []

/** 目标必须留在仓库内，否则拒绝删除（防止拼接出错删到工作区外）。 */
function assertInsideRoot(path) {
  const abs = resolve(path)
  const rel = relative(root, abs)
  if (rel === '' || rel.startsWith('..') || rel.startsWith(`..${sep}`)) {
    throw new Error(`拒绝删除仓库外的路径: ${abs}`)
  }
  return abs
}

function removePath(path, label) {
  let abs
  try {
    abs = assertInsideRoot(path)
  } catch (err) {
    failed.push({ path, error: err instanceof Error ? err.message : String(err) })
    return
  }
  if (!existsSync(abs)) {
    skipped.push({ path: abs, reason: '不存在' })
    return
  }
  if (dryRun) {
    removed.push(abs)
    console.log(`[clean] (dry-run) 将删除 ${label ?? ''} ${abs}`)
    return
  }
  try {
    const stat = statSync(abs)
    rmSync(abs, { recursive: stat.isDirectory(), force: true, maxRetries: 3 })
    removed.push(abs)
    console.log(`[clean] 已删除 ${label ?? ''} ${abs}`)
  } catch (err) {
    failed.push({ path: abs, error: err instanceof Error ? err.message : String(err) })
  }
}

/** 仓库根下的目录名（这些目录整体删除；node_modules 需显式开启）。 */
const JUNK_DIRS = ['.npm-cache', '.npm', '.pnpm-store', '.test-dist', 'coverage', '.nyc_output']
if (withNodeModules) JUNK_DIRS.push('node_modules')
for (const name of JUNK_DIRS) removePath(join(root, name), '目录')

/** 仓库根下的散落文件（历史打包产物 / 探针文件 / 日志）。 */
const JUNK_FILES = ['.probe.tmp']
for (const name of JUNK_FILES) removePath(join(root, name), '文件')
for (const entry of readdirSync(root)) {
  // 根目录下的 tgz 是历史打包产物；正式产物统一放 dist/
  if (entry.endsWith('.tgz')) removePath(join(root, entry), '文件')
  if (/^(npm-debug|yarn-error|pnpm-debug)\.log/.test(entry)) removePath(join(root, entry), '文件')
}

/** dist/ 只保留 .gitkeep（历史版本 tgz 没有保留价值，需要时可重新 npm pack）。 */
const distDir = join(root, 'dist')
if (!keepDist && existsSync(distDir)) {
  for (const entry of readdirSync(distDir)) {
    if (entry.endsWith('.tgz')) removePath(join(distDir, entry), '文件')
  }
}

console.log(`\n[clean] 删除 ${removed.length} 项，跳过 ${skipped.length} 项，失败 ${failed.length} 项`)
if (withNodeModules) console.log('[clean] 已删除 node_modules —— 请重新运行 npm install（或 pnpm install）')
if (failed.length > 0) process.exit(1)
