// Link the DSH runtime packages from the globally installed @deepseek-ai/dsh
// dependency tree into this project's node_modules for development-time type
// checking and unit tests. The built plugin declares them as externals and the
// DSH host provides them at runtime; this script only mirrors the exact
// installed versions so dev and production never drift.
//
// Idempotent AND self-healing: a mirrored package whose version no longer
// matches the installed DSH tree is re-copied, so upgrading the global dsh
// (for example 0.1.0-rc.6 -> 0.1.5-rc.1) only needs this script re-run. Packages
// npm owns (rollup, typescript, react, ...) are left alone.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

// Resolve the global dsh package. Windows: %APPDATA%/npm; POSIX: global prefix.
const appData = process.env.APPDATA ?? ''
const npmRoot =
  process.platform === 'win32' && appData
    ? join(appData, 'npm')
    : join(process.env.HOME ?? '', '.npm-global')
const dshPkg = join(npmRoot, 'node_modules', '@deepseek-ai', 'dsh')
const dshDeps = join(dshPkg, 'node_modules')

if (!existsSync(join(dshDeps, '@deepseek-ai'))) {
  console.error('[link-dsh] global @deepseek-ai/dsh dependency tree not found at', dshDeps)
  process.exit(1)
}

const targetRoot = join(root, 'node_modules')
mkdirSync(join(targetRoot, '@deepseek-ai'), { recursive: true })

/** Read one package's version, or undefined when it is not a readable package. */
function versionOf(dir) {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/**
 * Mirror one package directory when absent or version-drifted.
 * @returns 'copied' | 'refreshed' | 'kept'
 */
function mirror(name, src, dest) {
  const wanted = versionOf(src)
  if (existsSync(dest)) {
    if (wanted === undefined || versionOf(dest) === wanted) return 'kept'
    rmSync(dest, { recursive: true, force: true })
    cpSync(src, dest, { recursive: true })
    return 'refreshed'
  }
  cpSync(src, dest, { recursive: true })
  return 'copied'
}

const tally = { copied: 0, refreshed: 0, kept: 0 }
const record = (result) => { tally[result] += 1 }

// 1. Mirror @deepseek-ai/* (skip the dsh CLI package itself and .bin).
for (const name of readdirSync(join(dshDeps, '@deepseek-ai'))) {
  if (name === 'dsh' || name.startsWith('.')) continue
  const src = join(dshDeps, '@deepseek-ai', name)
  if (!statSync(src).isDirectory()) continue
  record(mirror(name, src, join(targetRoot, '@deepseek-ai', name)))
}

// 2. Mirror top-level deps that are NOT already installed by npm
// (zod, schemastery transitively needed by the linked packages).
for (const name of readdirSync(dshDeps)) {
  if (name === '@deepseek-ai' || name.startsWith('.')) continue
  const src = join(dshDeps, name)
  if (!statSync(src).isDirectory()) continue
  record(mirror(name, src, join(targetRoot, name)))
}

const dshVersion = versionOf(dshPkg) ?? 'unknown'
console.log(
  `[link-dsh] @deepseek-ai/dsh@${dshVersion}: copied ${String(tally.copied)}, ` +
  `refreshed ${String(tally.refreshed)}, kept ${String(tally.kept)}`,
)
