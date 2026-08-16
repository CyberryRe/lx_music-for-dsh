// Build script: bundles the host plugin (lib/index.js) and the browser client (lib/client.js).
// Uses rollup (pure JS — no native spawn), which works in restricted sandboxes.
// - host: ESM, externals = all @deepseek-ai/* + zod + schemastery (provided by the DSH runtime)
// - client: CJS wrapped in `window.__ModuleLoader__.load({ id, factory })`; externals = the DSH
//   browser kernel module table (react, @deepseek-ai/dsh-client-ui-primitives, ...).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { rollup } from 'rollup'
import typescript from '@rollup/plugin-typescript'
import { nodeResolve } from '@rollup/plugin-node-resolve'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const pkgName = pkg.name

const HOST_EXTERNALS = [/^@deepseek-ai\//, /^zod$/, /^schemastery$/, /^node:/]
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-attachment',
  '@deepseek-ai/dsh-client-schema-form',
]

const isHostExternal = (id) => HOST_EXTERNALS.some((re) => re.test(id))
const isClientExternal = (id) => CLIENT_EXTERNALS.includes(id)

// host bundle 是 ESM，没有 __dirname；banner 注入之（sandbox.ts 用它定位 runner）。
// 注意：导入名需加前缀，避免与 bundle 内其余 node:path 导入（dirname 等）重名冲突。
const HOST_BANNER = `import { dirname as lxmPathDirname } from 'node:path';\nimport { fileURLToPath as lxmFileURLToPath } from 'node:url';\nconst __dirname = lxmPathDirname(lxmFileURLToPath(import.meta.url));`

const tsPlugin = () => [
  nodeResolve({ extensions: ['.ts', '.tsx', '.js', '.mjs', '.json'] }),
  typescript({
    tsconfig: join(root, 'tsconfig.json'),
    compilerOptions: {
      noEmit: false,
      declaration: false,
      sourceMap: false,
      inlineSources: false,
      module: 'ESNext',
      // tsconfig 中 allowImportingTsExtensions 仅用于 tsc --noEmit 检查；
      // 构建时禁用（rollup 输出会重写为相对路径）。
      allowImportingTsExtensions: false,
    },
  }),
]

async function buildHost() {
  const bundle = await rollup({
    input: join(root, 'src/index.ts'),
    plugins: [tsPlugin()],
    external: (id) => isHostExternal(id),
    onwarn(warning, warn) {
      if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message)
      warn(warning)
    },
  })
  const { output } = await bundle.generate({ format: 'esm', banner: HOST_BANNER })
  await bundle.close()
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib/index.js'), output[0].code)
  console.log(`[build] lib/index.js (${output[0].code.length} bytes)`)
}

async function buildClient() {
  const bundle = await rollup({
    input: join(root, 'src/client.ts'),
    plugins: [tsPlugin()],
    external: (id) => isClientExternal(id),
    onwarn(warning, warn) {
      if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message)
      warn(warning)
    },
  })
  const { output } = await bundle.generate({
    format: 'cjs',
    // dsh client module table（window.__ModuleLoader__）以 CJS factory 物化 bundle：
    // factory 闭包内需要 module/exports 局部变量（与官方 bundle 一致），
    // 否则 rollup 输出的 `exports.x = ...` 在浏览器中抛 ReferenceError。
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(pkgName)}, factory: (require) => {
var module = { exports: {} };
var exports = module.exports;
`,
    footer: `return module.exports; } });`,
    sourcemap: false,
  })
  await bundle.close()
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib/client.js'), output[0].code)
  console.log(`[build] lib/client.js (${output[0].code.length} bytes)`)
}

/** 音源脚本隔离子进程（runner）：独立 CJS 产物 lib/runner.cjs，仅供 spawn 执行。 */
async function buildRunner() {
  const bundle = await rollup({
    input: join(root, 'src/engine/runner.js'),
    plugins: [nodeResolve({ extensions: ['.js'] })],
    external: (id) => /^node:/.test(id),
    onwarn(warning, warn) {
      if (warning.code === 'UNRESOLVED_IMPORT') throw new Error(warning.message)
      warn(warning)
    },
  })
  const { output } = await bundle.generate({ format: 'cjs' })
  await bundle.close()
  mkdirSync(join(root, 'lib'), { recursive: true })
  writeFileSync(join(root, 'lib/runner.cjs'), output[0].code)
  console.log(`[build] lib/runner.cjs (${output[0].code.length} bytes)`)
}

if (process.argv.includes('--watch')) {
  console.warn('[build] watch mode unavailable with rollup in this environment; rerun the script to rebuild.')
}

await buildHost()
await buildRunner()
await buildClient()
