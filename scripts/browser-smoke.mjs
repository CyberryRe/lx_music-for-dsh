// Browser smoke test: boots a real Chromium instance against a running dsh web
// profile and reports whether the web client booted and whether this plugin's
// client entry activated.
//
// Why: `dsh web` fails the whole GUI boot when any client plugin entry does not
// activate ("web boot: N entries did not activate"), so the only faithful check
// is a real browser. This script drives Chrome over the DevTools Protocol using
// `ws` (no puppeteer download required).
//
// Usage:
//   node scripts/browser-smoke.mjs <url> [--chrome <path>] [--timeout <ms>]
//
// Exit code 0 = GUI booted AND no console error/exception was observed.
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import WebSocket from 'ws'

const argv = process.argv.slice(2)
const url = argv.find((a) => !a.startsWith('--'))
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
if (url === undefined) {
  console.error('usage: node scripts/browser-smoke.mjs <url> [--chrome <path>] [--timeout <ms>]')
  process.exit(2)
}

const CHROME_CANDIDATES = [
  opt('chrome', ''),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean)

const chromePath = CHROME_CANDIDATES.find((p) => existsSync(p))
if (chromePath === undefined) {
  console.error('[browser-smoke] no Chromium browser found; pass --chrome <path>')
  process.exit(2)
}

const timeoutMs = Number(opt('timeout', '30000'))
const port = Number(opt('port', '9333'))
const profileDir = mkdtempSync(join(tmpdir(), 'lxm-smoke-'))

const chrome = spawn(chromePath, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--disable-sync',
  '--disable-background-networking',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profileDir}`,
  'about:blank',
], { stdio: ['ignore', 'pipe', 'pipe'] })
// Drain the browser's own pipes: a full pipe would block the child on Windows.
// Keep the tail of stderr for diagnostics when the endpoint never appears.
const chromeLog = []
const collect = (buf) => {
  chromeLog.push(buf.toString())
  if (chromeLog.length > 200) chromeLog.shift()
}
chrome.stdout.on('data', collect)
chrome.stderr.on('data', collect)
chrome.on('error', (err) => chromeLog.push(`spawn error: ${err.message}`))
chrome.on('exit', (code, signal) => chromeLog.push(`chrome exited code=${code} signal=${signal}`))

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function devtools(path, method = 'GET') {
  let lastError = 'unknown'
  for (let i = 0; i < 100; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, { method })
      if (res.ok) return await res.json()
      lastError = `HTTP ${res.status}`
    } catch (err) {
      lastError = err.message
    }
    await sleep(150)
  }
  throw new Error(`DevTools ${method} ${path} never succeeded (${lastError}):\n` + chromeLog.join(''))
}

const cleanup = () => {
  try { chrome.kill() } catch { /* already gone */ }
  try { rmSync(profileDir, { recursive: true, force: true }) } catch { /* best effort */ }
}

let exitCode = 1
try {
  // Chrome >= 111 requires PUT for /json/new (a GET answers 405).
  const target = await devtools(`/json/new?${encodeURIComponent('about:blank')}`, 'PUT')
  const ws = new WebSocket(target.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })

  let nextId = 1
  const pending = new Map()
  const consoleLines = []
  const pageErrors = []
  const failedRequests = []

  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString())
    if (msg.id !== undefined) {
      const slot = pending.get(msg.id)
      if (slot !== undefined) {
        pending.delete(msg.id)
        msg.error === undefined ? slot.resolve(msg.result) : slot.reject(new Error(msg.error.message))
      }
      return
    }
    if (msg.method === 'Runtime.consoleAPICalled') {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? a.type).join(' ')
      consoleLines.push({ level: msg.params.type, text })
    } else if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails
      pageErrors.push(d.exception?.description ?? d.text ?? 'exception')
    } else if (msg.method === 'Log.entryAdded') {
      const e = msg.params.entry
      if (e.level === 'error') pageErrors.push(`${e.source}: ${e.text}`)
    } else if (msg.method === 'Network.loadingFailed') {
      failedRequests.push(msg.params.errorText)
    }
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })

  await send('Runtime.enable')
  await send('Log.enable')
  await send('Network.enable')
  await send('Page.enable')
  await send('Page.navigate', { url })

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(500)
    // Stop early once the app root has rendered or the boot page reported failure.
    const probe = await send('Runtime.evaluate', {
      expression: `(() => {
        const root = document.getElementById('root');
        const text = document.body ? document.body.innerText : '';
        return JSON.stringify({
          booted: root !== null && root.childElementCount > 0,
          failure: /did not activate|web boot:|failed to boot/i.test(text) ? text.slice(0, 2000) : null,
        });
      })()`,
      returnByValue: true,
    })
    const value = JSON.parse(probe.result.value)
    if (value.failure !== null) {
      console.error('[browser-smoke] BOOT FAILURE:\n' + value.failure)
      break
    }
    if (value.booted) {
      await sleep(1500) // let plugin activation errors surface
      break
    }
  }

  const probe = await send('Runtime.evaluate', {
    expression: `(() => {
      const root = document.getElementById('root');
      const card = document.querySelector('.lxm-card');
      return JSON.stringify({
        booted: root !== null && root.childElementCount > 0,
        html: root === null ? '' : root.innerHTML.length,
        hasCard: card !== null,
        cardText: card === null ? '' : card.innerText.replace(/\\n+/g, ' | '),
        cardHtml: card === null ? '' : card.outerHTML.slice(0, 1500),
        windows: document.querySelectorAll('.lxm-window').length,
        bodyText: document.body ? document.body.innerText.slice(0, 1200) : '',
      });
    })()`,
    returnByValue: true,
  })
  const final = JSON.parse(probe.result.value)

  console.log('[browser-smoke] booted =', final.booted, '| root html length =', final.html)
  console.log('[browser-smoke] lx card present =', final.hasCard)
  if (final.hasCard) console.log('[browser-smoke] card text =', JSON.stringify(final.cardText))

  // Interaction probe: clicking the card body must open the plugin's main window,
  // which only happens when the host Remote service answers.
  let interactionsOk = false
  if (final.hasCard) {
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.lxm-card').click()`,
      returnByValue: true,
    })
    await sleep(1200)
    const after = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        windows: document.querySelectorAll('.lxm-window').length,
        title: (document.querySelector('.lxm-window-title') || {}).textContent || '',
        text: (document.querySelector('.lxm-window') || { innerText: '' }).innerText.replace(/\\n+/g, ' | ').slice(0, 400),
        errors: [...document.querySelectorAll('.lxm-error')].map((e) => e.innerText).slice(0, 3),
      })`,
      returnByValue: true,
    })
    const opened = JSON.parse(after.result.value)
    console.log('[browser-smoke] main window opened =', opened.windows > 0, '| title =', JSON.stringify(opened.title))
    if (opened.windows > 0) console.log('[browser-smoke] window text =', JSON.stringify(opened.text))
    if (opened.errors.length > 0) console.log('[browser-smoke] window errors =', JSON.stringify(opened.errors))

    // Close the main window again so the card controls are clickable.
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.lxm-window-close')?.click()`,
      returnByValue: true,
    })
    await sleep(400)

    // Parameterized Remote round-trip: the play-mode button calls
    // setPlayMode({ mode }), so a changed label proves object-argument wire
    // encoding still matches the host @Remote descriptors.
    const modeBefore = await send('Runtime.evaluate', {
      expression: `document.querySelector('.lxm-btn-mode')?.getAttribute('title') ?? ''`,
      returnByValue: true,
    })
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.lxm-btn-mode')?.click()`,
      returnByValue: true,
    })
    await sleep(1200)
    const modeAfter = await send('Runtime.evaluate', {
      expression: `document.querySelector('.lxm-btn-mode')?.getAttribute('title') ?? ''`,
      returnByValue: true,
    })
    const changed = modeBefore.result.value !== modeAfter.result.value
    console.log('[browser-smoke] setPlayMode round-trip =', changed,
      '| before =', JSON.stringify(modeBefore.result.value), '| after =', JSON.stringify(modeAfter.result.value))
    interactionsOk = opened.windows > 0 && changed && opened.errors.length === 0

    // Restore the mode this run changed: the profile under test persists play
    // mode, so a smoke run must not leave the user's player switched.
    for (let i = 0; i < 4; i++) {
      const now = await send('Runtime.evaluate', {
        expression: `document.querySelector('.lxm-btn-mode')?.getAttribute('title') ?? ''`,
        returnByValue: true,
      })
      if (now.result.value === modeBefore.result.value) break
      await send('Runtime.evaluate', {
        expression: `document.querySelector('.lxm-btn-mode')?.click()`,
        returnByValue: true,
      })
      await sleep(600)
    }

    // Settings window exercises listSources() + getSettings() + the settings form.
    await send('Runtime.evaluate', {
      expression: `document.querySelector('.lxm-btn[aria-label="设置"]')?.click()`,
      returnByValue: true,
    })
    await sleep(1500)
    const settings = await send('Runtime.evaluate', {
      expression: `JSON.stringify({
        open: document.querySelector('.lxm-window') !== null,
        text: (document.querySelector('.lxm-window') || { innerText: '' }).innerText.replace(/\\n+/g, ' | ').slice(0, 300),
        errors: [...document.querySelectorAll('.lxm-error')].map((e) => e.innerText).slice(0, 3),
      })`,
      returnByValue: true,
    })
    const settingsState = JSON.parse(settings.result.value)
    console.log('[browser-smoke] settings window =', settingsState.open, '| text =', JSON.stringify(settingsState.text))
    if (settingsState.errors.length > 0) console.log('[browser-smoke] settings errors =', JSON.stringify(settingsState.errors))
    interactionsOk = interactionsOk && settingsState.open && settingsState.errors.length === 0
  }

  const noisy = consoleLines.filter((l) => l.level === 'error' || l.level === 'warning')
  for (const l of noisy) console.log(`[console.${l.level}] ${l.text}`)
  for (const e of pageErrors) console.log(`[page-error] ${e}`)
  for (const f of failedRequests) console.log(`[request-failed] ${f}`)
  if (!final.booted) console.error('[browser-smoke] page body:\n' + final.bodyText)

  exitCode = final.booted && pageErrors.length === 0 && (final.hasCard ? interactionsOk : true) ? 0 : 1
  ws.close()
} catch (err) {
  console.error('[browser-smoke] harness error:', err)
} finally {
  cleanup()
}
process.exit(exitCode)
