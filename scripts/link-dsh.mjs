// Link the DSH runtime packages from the globally installed @deepseek-ai/dsh
// dependency tree into this project's node_modules for development-time type
// checking and unit tests. The built plugin declares them as externals and the
// DSH host provides them at runtime; this script only mirrors the exact
// installed versions (0.1.0-rc.6) so dev and production never drift.
//
// Idempotent: existing directories are kept (npm may manage some of them).
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
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

// 1. Mirror @deepseek-ai/* (skip the dsh CLI package itself and .bin).
let copied = 0
for (const name of readdirSync(join(dshDeps, '@deepseek-ai'))) {
  if (name === 'dsh' || name.startsWith('.')) continue
  const src = join(dshDeps, '@deepseek-ai', name)
  if (!statSync(src).isDirectory()) continue
  const dest = join(targetRoot, '@deepseek-ai', name)
  if (existsSync(dest)) continue
  cpSync(src, dest, { recursive: true })
  copied++
}

// 2. Mirror top-level deps that are NOT already installed by npm
// (zod, schemastery transitively needed by the linked packages).
for (const name of readdirSync(dshDeps)) {
  if (name === '@deepseek-ai' || name.startsWith('.')) continue
  const src = join(dshDeps, name)
  if (!statSync(src).isDirectory()) continue
  const dest = join(targetRoot, name)
  if (existsSync(dest)) continue
  cpSync(src, dest, { recursive: true })
  copied++
}

console.log(`[link-dsh] linked ${copied} packages from ${dshDeps}`)
