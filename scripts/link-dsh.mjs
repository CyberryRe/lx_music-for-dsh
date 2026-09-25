// Mirror the DSH runtime dependency tree into this project's node_modules so
// development-time type checking and unit tests run against the exact package
// versions the plugin loads at runtime. The built plugin declares them as
// externals and the DSH host provides them live; this script only mirrors the
// installed versions so dev and production never drift.
//
// Sources, highest priority first:
//   1. --from <dir> / $DSH_RUNTIME_DIR   explicit tree
//   2. node_modules/@deepseek-ai/dsh     project-local (npm devDependency)
//   3. the global npm install tree       (what `dsh plugin add` itself uses)
//
// `--source local|global` forces one of the automatic sources.
//
// The mirrored tree must be a *published npm* tree: the desktop app ships its
// runtime inside resources/app.asar with the TypeScript declarations stripped
// for size, so it cannot serve `tsc`. This script therefore only reads the
// desktop app's version from its asar header and **refuses to mirror** when the
// source version differs from the app that actually runs the GUI (override with
// `--allow-drift`) — otherwise a stale global `@deepseek-ai/dsh` would silently
// replace the dev tree with the wrong API surface.
//
// Idempotent and self-healing: an @deepseek-ai/* package whose version no longer
// matches is re-copied and packages the source no longer ships are pruned, so
// upgrading DSH only needs `npm run setup` re-run. Everything npm owns (rollup,
// typescript, react, zod, @types/*, other scopes) is never replaced — only
// missing packages are filled in and version differences are reported, because
// the host supplies those at runtime anyway.
import { cpSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const targetRoot = join(root, 'node_modules')
const PACKAGE_SCOPE = '@deepseek-ai'

/** The launcher package itself: never mirrored (nothing in the plugin imports it). */
const SKIP_PACKAGES = new Set(['dsh'])

/**
 * Mirroring a single package larger than this is skipped: at this size it is a
 * platform binary (LibreOffice SDK, sherpa-onnx, sharp, ...) that neither the
 * type checker nor the tests load. `--full` mirrors it anyway.
 */
const SIZE_LIMIT_BYTES = 40 * 1024 * 1024

/** A source with fewer scoped packages than this is treated as partial (no prune). */
const MIN_SCOPE_FOR_PRUNE = 20

// ── arguments ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { from: '', asar: '', source: '', full: false, prune: true, force: false, allowDrift: false, help: false }
  const take = (index, inline) => (inline !== '' ? inline : argv[index + 1] ?? '')
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--from' || arg.startsWith('--from=')) opts.from = take(i, arg.slice('--from='.length))
    else if (arg === '--asar' || arg.startsWith('--asar=')) opts.asar = take(i, arg.slice('--asar='.length))
    else if (arg === '--source' || arg.startsWith('--source=')) opts.source = take(i, arg.slice('--source='.length))
    else if (arg === '--full') opts.full = true
    else if (arg === '--force') opts.force = true
    else if (arg === '--allow-drift') opts.allowDrift = true
    else if (arg === '--no-prune') opts.prune = false
    else if (arg === '--help' || arg === '-h') opts.help = true
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

if (opts.help) {
  console.log(`用法: node scripts/link-dsh.mjs [选项]

  --from <dir>       显式指定 DSH 运行时目录（其 node_modules，或 DSH 包目录）
  --source <kind>    强制自动来源：local | global
  --force            忽略版本号，强制重新镜像 @deepseek-ai/*（修复损坏的镜像）
  --full             连超过 ${String(SIZE_LIMIT_BYTES / 1024 / 1024)} MB 的平台二进制包一起镜像
  --no-prune         不删除来源已不再提供的 @deepseek-ai/* 包
  --allow-drift      镜像版本与桌面版 DSH 不一致时仍继续（默认拒绝，避免装错版本）
  --asar <file>      桌面版 app.asar 路径（默认自动探测，用于版本比对）

环境变量：DSH_RUNTIME_DIR（同 --from）、DSH_DESKTOP_ASAR（同 --asar）

注意：来源必须是 npm 发布的 @deepseek-ai/dsh 依赖树；桌面版 app.asar 内只有运行时
JS（.d.ts 已剥离），无法用于类型检查，因此本脚本只用它读取版本做漂移比对。`)
  process.exit(0)
}

// ── small fs helpers ─────────────────────────────────────────────────────────

const isDir = (path) => {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Read one package's version, or undefined when it is not a readable package. */
function versionOfDir(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

function dirSizeOf(dir) {
  let total = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    total += entry.isDirectory() ? dirSizeOf(path) : statSync(path).size
  }
  return total
}

function readFully(fd, buffer, position) {
  let read = 0
  while (read < buffer.length) {
    const n = readSync(fd, buffer, read, buffer.length - read, position + read)
    if (n === 0) throw new Error(`unexpected EOF after ${String(read)}/${String(buffer.length)} bytes`)
    read += n
  }
  return buffer
}

// ── desktop app version probe ────────────────────────────────────────────────

/**
 * Read a JSON entry from an Electron asar archive. The container is a JSON
 * directory header followed by concatenated file contents; reaching one small
 * file needs no dependency and no extraction.
 */
function asarJson(asarPath, rel) {
  const fd = openSync(asarPath, 'r')
  const probe = Buffer.alloc(16)
  readFully(fd, probe, 0)
  const dataStart = 8 + probe.readUInt32LE(4)
  const jsonLength = probe.readUInt32LE(12)
  const header = JSON.parse(readFully(fd, Buffer.alloc(jsonLength), 16).toString('utf8'))
  let node = header
  for (const part of rel.split('/')) {
    node = node?.files?.[part]
    if (node === undefined) return undefined
  }
  if (node?.size === undefined) return undefined
  return JSON.parse(readFully(fd, Buffer.alloc(node.size), dataStart + Number(node.offset)).toString('utf8'))
}

/** Well-known desktop install locations, plus anything named explicitly. */
function desktopAsarCandidates() {
  const explicit = opts.asar || process.env.DSH_DESKTOP_ASAR
  if (explicit) return [explicit]
  const out = []
  const push = (base) => {
    if (base) out.push(join(base, 'DeepSeek Harness', 'resources', 'app.asar'))
  }
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) push(join(process.env.LOCALAPPDATA, 'Programs'))
    push(process.env['ProgramFiles'])
    push(process.env['ProgramFiles(x86)'])
  } else {
    push('/Applications')
    push(join(process.env.HOME ?? '', 'Applications'))
  }
  return out
}

/** Version of the desktop app's runtime, or undefined when it is not installed here. */
function desktopRuntimeVersion() {
  for (const candidate of desktopAsarCandidates()) {
    if (!existsSync(candidate)) continue
    for (const rel of ['dsh/package.json', `${'dsh/node_modules'}/${PACKAGE_SCOPE}/dsh-base/package.json`]) {
      try {
        const pkg = asarJson(candidate, rel)
        if (typeof pkg?.version === 'string') return { version: pkg.version, source: candidate }
      } catch {
        // try the next candidate
      }
    }
  }
  return undefined
}

// ── source discovery ─────────────────────────────────────────────────────────

/** Normalize an explicit path into the directory holding the mirrored scope. */
function sourceFromPath(path, label) {
  if (!isDir(path)) return undefined
  // A DSH package directory: its dependencies live in its own node_modules.
  if (isDir(join(path, 'node_modules', PACKAGE_SCOPE))) return { base: join(path, 'node_modules'), label }
  // A node_modules directory, or any directory directly holding the scope.
  if (isDir(join(path, PACKAGE_SCOPE))) return { base: path, label }
  return undefined
}

function discover() {
  const attempts = []
  const forced = opts.source

  if (opts.from || process.env.DSH_RUNTIME_DIR) {
    const path = opts.from || process.env.DSH_RUNTIME_DIR || ''
    const source = sourceFromPath(path, `--from ${path}`)
    if (source) return { source, attempts }
    attempts.push(`${path}（不可用：需要其 node_modules 或 DSH 包目录）`)
  }
  if (!forced || forced === 'local') {
    const local = join(targetRoot, PACKAGE_SCOPE, 'dsh')
    const source = sourceFromPath(local, '项目内 devDependency')
    if (source) return { source, attempts }
    attempts.push('项目内 node_modules/@deepseek-ai/dsh（不存在）')
  }
  if (!forced || forced === 'global') {
    const appData = process.env.APPDATA ?? ''
    const npmRoot = process.platform === 'win32' && appData ? join(appData, 'npm') : join(process.env.HOME ?? '', '.npm-global')
    const global = join(npmRoot, 'node_modules', PACKAGE_SCOPE, 'dsh')
    const source = sourceFromPath(global, '全局 npm 安装')
    if (source) return { source, attempts }
    attempts.push(`全局 ${global}（不存在）`)
  }
  return { source: undefined, attempts }
}

// ── mirror ───────────────────────────────────────────────────────────────────

const { source, attempts } = discover()

if (source === undefined) {
  console.error('[link-dsh] 未找到 DSH 运行时依赖树。已尝试：')
  for (const attempt of attempts) console.error(`  - ${attempt}`)
  const desktop = desktopRuntimeVersion()
  const hint = desktop === undefined ? '@deepseek-ai/dsh@<版本>' : `@deepseek-ai/dsh@${desktop.version}`
  console.error('\n请用 --from <dir> / $DSH_RUNTIME_DIR 指定运行时，或安装它：')
  console.error(`  npm i -g ${hint}`)
  if (desktop !== undefined) console.error(`（版本取自桌面版：${desktop.source}）`)
  process.exit(1)
}

const base = source.base
const scopeDir = join(base, PACKAGE_SCOPE)
const runtimeVersion = versionOfDir(join(scopeDir, 'dsh')) ?? versionOfDir(join(scopeDir, 'dsh-base')) ?? 'unknown'

console.log(`[link-dsh] 来源：${source.label}（DSH ${runtimeVersion}）`)
console.log(`[link-dsh] 路径：${base}`)

const desktop = desktopRuntimeVersion()
if (desktop === undefined) {
  console.log('[link-dsh] 未检测到桌面版 DSH；跳过版本比对。')
} else if (desktop.version === runtimeVersion) {
  console.log(`[link-dsh] 与桌面版一致：${desktop.version}`)
} else {
  const message =
    `[link-dsh] 版本不一致：镜像来源为 DSH ${runtimeVersion}，而桌面版（${desktop.source}）为 ${desktop.version}。\n` +
    `           插件实际加载进桌面版运行时，装错版本会让开发/测试对着错误的 API 表面跑。\n` +
    '           请先升级来源：npm i -g @deepseek-ai/dsh@' + desktop.version + '\n' +
    `           或指定正确来源：node scripts/link-dsh.mjs --from <dir>；确实要用 ${runtimeVersion} 就加 --allow-drift。`
  // 默认拒绝：镜像会覆盖/清理 @deepseek-ai/*，用错版本会把开发树静默换掉。
  if (!opts.allowDrift) {
    console.error(message)
    process.exit(1)
  }
  console.warn(message)
}

const tally = { copied: 0, refreshed: 0, kept: 0, skipped: 0, pruned: 0, drift: [] }
const record = (result) => { tally[result] += 1 }

/**
 * Mirror one package of the `@deepseek-ai` scope — the packages the built
 * plugin treats as externals. Re-copies when the destination is missing, its
 * version drifted, or `--force` asks for a clean rebuild.
 * @returns 'copied' | 'refreshed' | 'kept' | 'skipped'
 */
function mirrorScoped(rel, dest) {
  const size = dirSizeOf(join(base, rel))
  if (size > SIZE_LIMIT_BYTES && !opts.full) {
    console.log(`[link-dsh] 跳过 ${rel}（${(size / 1024 / 1024).toFixed(0)} MB 平台二进制包；--full 可强制镜像）`)
    return 'skipped'
  }
  const wanted = versionOfDir(join(base, rel))
  const existed = existsSync(dest)
  if (existed && !opts.force && (wanted === undefined || versionOfDir(dest) === wanted)) return 'kept'
  rmSync(dest, { recursive: true, force: true })
  cpSync(join(base, rel), dest, { recursive: true })
  return existed ? 'refreshed' : 'copied'
}

/**
 * Fill a dependency gap for anything outside the mirrored scope (zod,
 * cosmokit, typebox, @types/*, ...). npm's own tree is authoritative here: an
 * existing package is never replaced, only reported when it differs, because
 * the host supplies these at runtime and its own toolchain must stay intact.
 * @returns 'copied' | 'kept' | 'skipped'
 */
function fillGap(rel) {
  const dest = join(targetRoot, rel)
  const wanted = versionOfDir(join(base, rel))
  if (existsSync(dest)) {
    const actual = versionOfDir(dest)
    if (wanted !== undefined && actual !== undefined && actual !== wanted) {
      tally.drift.push(`${rel}: npm ${actual} vs DSH ${wanted}`)
    }
    return 'kept'
  }
  const size = dirSizeOf(join(base, rel))
  if (size > SIZE_LIMIT_BYTES && !opts.full) return 'skipped'
  cpSync(join(base, rel), dest, { recursive: true })
  return 'copied'
}

mkdirSync(join(targetRoot, PACKAGE_SCOPE), { recursive: true })

// 1. @deepseek-ai/* — the mirrored externals.
const scopeNames = readdirSync(scopeDir).filter((name) => isDir(join(scopeDir, name)))
for (const name of scopeNames) {
  if (SKIP_PACKAGES.has(name)) continue
  record(mirrorScoped(`${PACKAGE_SCOPE}/${name}`, join(targetRoot, PACKAGE_SCOPE, name)))
}

// 2. Everything else the linked packages need. Scopes are walked per package so
//    a partially overlapping scope (npm's @types vs the runtime's) is never
//    wholesale replaced.
for (const name of readdirSync(base)) {
  if (name === PACKAGE_SCOPE || name.startsWith('.') || !isDir(join(base, name))) continue
  if (name.startsWith('@')) {
    for (const sub of readdirSync(join(base, name))) {
      if (isDir(join(base, name, sub))) record(fillGap(`${name}/${sub}`))
    }
  } else {
    record(fillGap(name))
  }
}

// 3. Prune scoped packages the source no longer ships, so a DSH upgrade does
//    not leave a stale (and type-confusing) copy behind.
if (opts.prune && scopeNames.length >= MIN_SCOPE_FOR_PRUNE) {
  const wanted = new Set([...scopeNames, ...SKIP_PACKAGES])
  for (const name of readdirSync(join(targetRoot, PACKAGE_SCOPE))) {
    if (wanted.has(name)) continue
    rmSync(join(targetRoot, PACKAGE_SCOPE, name), { recursive: true, force: true })
    console.log(`[link-dsh] 清理已不再提供的包：${PACKAGE_SCOPE}/${name}`)
    tally.pruned += 1
  }
}

console.log(
  `[link-dsh] 完成：新增 ${String(tally.copied)}，更新 ${String(tally.refreshed)}，` +
  `保持 ${String(tally.kept)}，跳过 ${String(tally.skipped)}，清理 ${String(tally.pruned)}`,
)
if (tally.drift.length > 0) {
  console.warn('[link-dsh] 以下包 npm 版本与 DSH 运行时不同（已保留 npm 版本，运行时由宿主提供）：')
  for (const line of tally.drift) console.warn(`  - ${line}`)
}

if (runtimeVersion === 'unknown') {
  console.warn('[link-dsh] 无法识别来源的 DSH 版本，请确认来源正确。')
}
