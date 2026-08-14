// 临时探测脚本：测试 GitHub raw / 代理可达性，并抓取音源脚本内容。
const targets = [
  'https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js',
  'https://ghproxy.net/https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js',
  'https://gh-proxy.com/https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js',
  'https://ghfast.top/https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js',
  'https://ghproxy.cc/https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js',
  'https://mirror.ghproxy.com/https://raw.githubusercontent.com/pdone/lx-music-source/main/huibq/latest.js',
]

for (const u of targets) {
  const t0 = Date.now()
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(25000) })
    const text = await res.text()
    const api = text.match(/API_URL\s*=\s*['"]([^'"]+)/)
    const ver = text.match(/@version\s+(.+)/)
    console.log(
      `${res.status} ${Date.now() - t0}ms len=${text.length} ver=${ver?.[1]?.trim() ?? '-'} api=${api?.[1] ?? '-'}\n   ${u}`,
    )
  } catch (e) {
    console.log(`ERR ${Date.now() - t0}ms ${e.name}:${e.message}\n   ${u}`)
  }
}
