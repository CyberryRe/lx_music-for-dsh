// 测试编译：用 TypeScript 编译器 API（纯进程内，无子进程 spawn）把测试与源码编译为
// CommonJS 到 .test-dist/，供 `node --test` 单进程执行（受限沙箱环境）。
// 用法：node scripts/compile-tests.mjs && node --test --test-concurrency=1 .test-dist/tests

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const outDir = join(root, '.test-dist')
const configPath = join(root, 'tsconfig.tests.json')

const configFile = ts.readConfigFile(configPath, ts.sys.readFile)
if (configFile.error) {
  console.error('[compile-tests] 读取 tsconfig.tests.json 失败:', configFile.error)
  process.exit(1)
}
const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root)
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })
// 根 package.json 是 "type": "module"，CJS 输出目录用目录级 package.json 覆盖为 commonjs。
writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'commonjs' }))

const program = ts.createProgram(parsed.fileNames, {
  ...parsed.options,
  outDir,
  noEmit: false,
  declaration: false,
  sourceMap: false,
})
const emitResult = program.emit()

const diagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics)
if (diagnostics.length > 0) {
  for (const d of diagnostics) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, '\n')
    const pos = d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start) : null
    console.error(`[compile-tests] ${d.file?.fileName ?? ''}${pos ? `:${pos.line + 1}:${pos.character + 1}` : ''} ${msg}`)
  }
  process.exit(1)
}
console.log(`[compile-tests] compiled ${parsed.fileNames.length} files → ${outDir}`)
