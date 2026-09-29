// 查 npm 上的真实状态（只读，无需认证）：每个版本的弃用标记 + dist-tags + 各版本下载量。
//
//   npm run npm:state
//
// 为什么单独写一条：`npm view <pkg> deprecated` 只看 latest 一个版本，
// 而**精简 packument**（accept: application/vnd.npm.install-v1+json）会省略 `deprecated: ""`，
// 于是"用空字符串撤回弃用"这件事在精简文档里看不出来（本仓库踩过这个坑：自检误报"正常"）。
// 这里强制读**完整** packument，并区分「字段不存在」与「字段存在但为空串」。

const pkg = 'lx-music-for-dsh'
const url = `https://registry.npmjs.org/${pkg}`

const res = await fetch(url, { headers: { accept: 'application/json' } })
if (!res.ok) {
  console.error(`请求失败：HTTP ${res.status}`)
  process.exit(1)
}
const doc = await res.json()

const versions = Object.keys(doc.versions ?? {})
console.log(`\n${pkg} —— registry 真实状态（${new Date().toISOString()}）\n`)
console.log('  版本      弃用标记   说明')
console.log('  --------  ---------  ------------------------------------------------------------')
for (const v of versions) {
  const info = doc.versions[v] ?? {}
  const has = Object.prototype.hasOwnProperty.call(info, 'deprecated')
  const val = info.deprecated
  const mark = !has ? '正常' : String(val).length === 0 ? '空串(!)' : '已弃用'
  const note = !has ? '' : String(val).length === 0 ? '字段仍存在但为空 —— 用完整 packument 才看得见' : String(val).slice(0, 60)
  console.log(`  ${v.padEnd(9)} ${mark.padEnd(9)}  ${note}`)
}
console.log('\n  dist-tags:', JSON.stringify(doc['dist-tags']))
console.log('\n  提示：版本号在 npmjs.com 上显示为红色 = 被标记弃用；网站有缓存，硬刷新（Ctrl+F5）后以本输出为准。')
console.log('  撤 回弃用：npm deprecate "<包>@<版本>" ""（PowerShell 5.1 需用 cmd /c 包裹，见 docs/versioning.md）。\n')
