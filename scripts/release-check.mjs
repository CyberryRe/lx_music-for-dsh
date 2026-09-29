// 发布前自检：把"版本管理"里最容易搞错的东西一次查完。
//
//   npm run release:check            # 全量（含全部单测）
//   npm run release:check -- --quick # 跳过单测（只查元数据 + 打包）
//
// 检查项：
//   1. 版本号三处一致：package.json / manifest.json / src/status.ts 的 PLUGIN_VERSION
//   2. 工作区是否干净；HEAD 是否已有对应 tag（没有就提示打 tag 的命令）
//   3. cordis.patch.yml 的 config 与 Config schema 是否匹配（多写/少写/漏同步都会在这里炸）
//   4. 门禁：typecheck / lint /（可选）test
//   5. 打包并打印 sha1 + 文件清单，最后打印下一步命令
//
// 只读 + 只在 dist/ 下单文件，不改仓库状态。

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()
const quick = process.argv.includes('--quick')
const problems = []
const notes = []

const read = (p) => readFileSync(join(root, p), 'utf8')
const step = (title) => console.log(`\n=== ${title} ===`)
const ok = (msg) => console.log(`  ✅ ${msg}`)
const bad = (msg) => {
  problems.push(msg)
  console.log(`  ❌ ${msg}`)
}
const info = (msg) => console.log(`  ·  ${msg}`)
const run = (cmd, args) => {
  // Windows 下 npm/tsc 都是 .cmd，需要 shell；但把参数数组交给 shell 会触发 DEP0190 噪音，
  // 所以这里拼成**整行命令**再执行（参数里没有空格/引号，安全）。
  const onWindows = process.platform === 'win32'
  const line = [cmd, ...args].map((part) => (part.includes(' ') ? `"${part}"` : part)).join(' ')
  try {
    execFileSync(onWindows ? line : cmd, onWindows ? [] : args, {
      cwd: root,
      stdio: 'pipe',
      shell: onWindows,
    })
    return { ok: true, out: '' }
  } catch (err) {
    return { ok: false, out: `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim() }
  }
}

/** 需要拿到 stdout 的调用（execFileSync 的返回值就是输出）。 */
const runCapture = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { cwd: root, stdio: 'pipe' }).toString() }
  } catch (err) {
    return { ok: false, out: `${err.stdout?.toString() ?? ''}${err.stderr?.toString() ?? ''}`.trim() }
  }
}

// ── 1) 版本号三处一致 ────────────────────────────────────────────────────────
step('版本号一致性')
const pkg = JSON.parse(read('package.json'))
const manifest = JSON.parse(read('manifest.json'))
const statusTs = read('src/status.ts')
const statusVersion = /PLUGIN_VERSION\s*=\s*'([^']+)'/.exec(statusTs)?.[1]
info(`package.json      : ${pkg.version}`)
info(`manifest.json     : ${manifest.version}`)
info(`PLUGIN_VERSION    : ${statusVersion ?? '(未找到)'}`)
if (pkg.version === manifest.version && pkg.version === statusVersion) ok('三处一致')
else bad(`版本号不一致（package=${pkg.version} manifest=${manifest.version} status=${statusVersion}）`)

// ── 2) 工作区与 tag ─────────────────────────────────────────────────────────
step('git 状态与 tag')
const status = run('git', ['status', '--porcelain'])
if (status.ok && status.out.trim() === '') ok('工作区干净')
else bad('工作区有未提交改动（发布前先提交）')
const head = run('git', ['rev-parse', 'HEAD'])
const tagName = `v${pkg.version}`
const tagRef = run('git', ['rev-parse', '-q', '--verify', `refs/tags/${tagName}`])
if (tagRef.ok && tagRef.out.trim() === head.out.trim()) ok(`tag ${tagName} 已指向 HEAD`)
else if (tagRef.ok) bad(`tag ${tagName} 存在但不指向 HEAD（先删掉重打）`)
else info(`还没有 tag ${tagName} → 发布时执行：git tag -a ${tagName} -m "…" && git push origin main ${tagName}`)

// ── 3) 随包 patch 与 Config schema ──────────────────────────────────────────
step('cordis.patch.yml 与 Config')
try {
  const patch = read('cordis.patch.yml')
  const lines = patch.split(/\r?\n/)
  const start = lines.findIndex((l) => /^\s*config:\s*$/.test(l))
  const indent = /^(\s*)/.exec(lines[start] ?? '')?.[1] ?? ''
  const body = []
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') continue
    if (!line.startsWith(`${indent}  `)) break
    if (/^\s*#/.test(line)) continue
    body.push(line.trim())
  }
  const parsed = {}
  for (const line of body) {
    const [rawKey, ...rest] = line.split(':')
    const raw = rest.join(':').trim().replace(/^['"]|['"]$/g, '')
    parsed[(rawKey ?? '').trim()] = raw.startsWith('[')
      ? JSON.parse(raw.replace(/'/g, '"'))
      : raw === 'true'
        ? true
        : raw === 'false'
          ? false
          : /^-?\d+(\.\d+)?$/.test(raw)
            ? Number(raw)
            : raw
  }
  // 用真实 schema 校验（schemastery：多写/少写必需字段都会抛）
  const { pathToFileURL } = await import('node:url')
  const { Config } = await import(pathToFileURL(join(root, 'lib', 'index.js')).href)
  Config(parsed)
  ok(`patch 的 config 通过校验（${Object.keys(parsed).length} 个键）`)
  // schema 里声明的键是否都出现在 patch 里（便于发现"加了配置项忘了同步"）
  const srcIndex = read('src/index.ts')
  const declared = [...srcIndex.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*):\s*z\./gm)].map((m) => m[1])
  const missing = declared.filter((k) => !(k in parsed))
  if (missing.length > 0) info(`schema 有但 patch 未列出的键（有默认值也能跑，建议补上）：${missing.join(', ')}`)
  else ok('schema 的所有键都在 patch 里列出了')
} catch (err) {
  bad(`patch/Config 校验失败：${err instanceof Error ? err.message : String(err)}`)
}

// ── 4) 门禁 ─────────────────────────────────────────────────────────────────
step('门禁')
for (const [name, args] of [
  ['typecheck', ['run', 'typecheck']],
  ['lint', ['run', 'lint']],
  ...(quick ? [] : [['test', ['test']]]),
]) {
  const r = run('npm', args)
  if (r.ok) ok(`${name} 通过`)
  else bad(`${name} 失败：\n${r.out.split('\n').slice(-12).join('\n')}`)
}
if (quick) info('（--quick：跳过了单测）')

// ── 5) 打包 ─────────────────────────────────────────────────────────────────
step('打包产物')
const distDir = join(root, 'dist')
if (!existsSync(distDir)) mkdirSync(distDir, { recursive: true })
const filesBefore = new Set(existsSync(distDir) ? readdirSync(distDir) : [])
const pack = run('npm', ['pack', '--ignore-scripts', '--pack-destination', 'dist'])
const tarball = readdirSync(distDir).find((f) => f.startsWith(`lx-music-for-dsh-${pkg.version}`) && f.endsWith('.tgz'))
if (tarball) {
  const full = join(distDir, tarball)
  const { createHash } = await import('node:crypto')
  const sha1 = createHash('sha1').update(readFileSync(full)).digest('hex')
  const sha256 = createHash('sha256').update(readFileSync(full)).digest('hex')
  ok(`${tarball}  ${statSync(full).size} 字节`)
  info(`sha1  : ${sha1}`)
  info(`sha256: ${sha256}`)
  // 内容清单（发布前扫一眼有没有漏文件/漏构建产物）
  const list = runCapture('tar', ['-tzf', full])
  if (list.ok) {
    const entries = list.out.split(/\r?\n/).filter((l) => l.trim() !== '')
    info(`包含 ${entries.length} 项：${entries.map((l) => l.replace('package/', '')).join(', ')}`)
  }
} else {
  bad(`打包失败：${pack.out.split('\n').slice(-6).join('\n')}`)
}
void filesBefore
void rmSync

// ── 结论与下一步 ────────────────────────────────────────────────────────────
step('结论')
if (problems.length === 0) {
  console.log('  ✅ 可以发布。')
  console.log('\n  下一步（二选一）：')
  console.log(`    A) 走 CI（推荐，带 provenance 签名）：`)
  console.log(`       git tag -a ${tagName} -m "${pkg.version}: …" && git push origin main ${tagName}`)
  console.log(`    B) 本地补发（会要一次性验证码）：`)
  console.log(`       npm publish --ignore-scripts --access public`)
  console.log(`       npm dist-tag add lx-music-for-dsh@${pkg.version} lts`)
  console.log('\n  发布后记得：更新 docs/versioning.md 的对照表（并入 CHANGELOG 式说明）。')
} else {
  console.log(`  ❌ 有 ${problems.length} 项需要先处理：`)
  for (const p of problems) console.log(`     - ${p.split('\n')[0]}`)
  process.exitCode = 1
}
for (const n of notes) console.log(`  ·  ${n}`)
