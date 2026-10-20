#!/usr/bin/env node
// lane-visual — visual acceptance for a hub lane's OWN Next.js build.
//
// Serves the lane's standalone build (`node <app>/.next/standalone/<server.js>`)
// on a per-lane port (the lane's `next build` gate must already have run), then
// for every route × device (iPhone 13 @ 390 and desktop @ 1440) loads the page
// signed-out, records page errors / console errors / failed requests, checks
// the mobile invariants, and writes fold + full-page JPEGs plus a report to the
// evidence dir. Exit code 1 when any invariant fails, 2 when the probe cannot
// run. Never points at the LAN or beta hosts: the browser only ever navigates
// to localhost:<port>; names in `hostMappings` resolve to 127.0.0.1 (e.g.
// beatpath's Convex via nginx — reads only, signed out) and requests to
// `denyHosts` are aborted and listed in the report.
//
//   node ~/.claude/scripts/lane-visual.mjs \
//     --repo /home/mdv/code/<repo>-lanes/lane-3 --lane 3 \
//     --routes /,/coverage --out openspec/changes/<change>/evidence/<task>
//
// Per-repo configuration: `<repo>/.hub-visual.json` (tracked, like
// `.hub-base-branch`), or `--config <file>`. Every key is optional:
//   delegate         a repo-vendored probe (path relative to the repo) that this
//                    script hands every flag to and whose exit code it returns —
//                    for a repo that owns its gate logic (beatpath's planned
//                    tools/capture/lane-visual.mjs, mobile-acceptance-automation D2)
//   appDir           dir holding next.config + .next, relative to the repo  (auto: frontend/ if it has .next or next.config.*, else .)
//   serverJs         server.js path inside <appDir>/.next/standalone       (auto: server.js, else <appDir>/server.js)
//   portBase         port = portBase + lane                                   (3100)
//   defaultRoutes    routes when --routes is omitted                          (["/"])
//   envFiles         dotenv files merged into the server env, later wins      ([])
//   env              extra server env, applied after envFiles                 ({})
//   hostMappings     host names the browser resolves to 127.0.0.1             ([])
//   denyHosts        hosts whose requests are aborted (`*.x.com` ok)          ([])
//   launchArgs       extra chromium args (e.g. SwiftShader for WebGL)         ([])
//   playwrightFrom   dirs to resolve `playwright`/`@playwright/test` from     (["${LANE_VISUAL_CAPTURE_DIR:-}", "{repo}", "{app}", "{main}"])
//   ignoreConsole    regex sources; matching console errors are dropped      ([])
//   errorBoundaryText  regex sources; body text matching = route error boundary (beatpath's copy)
//   minTextChars     "thin page" floor                                        (200)
//   minTextCharsByRoute  per-route floor, keyed by path without query (a map-first page) ({})
//   failOnHttpStatus a document status >= this fails the route               (null = report only)
//   settleMs         wait after load                                          (6000)
// String values expand {repo} (the worktree), {main} (the main checkout the
// worktree belongs to), {app}, {lane}, {port} and ${NAME:-default} from the
// environment. Without a config file, a repo with frontend/ gets the
// built-in beatpath profile (the script's original behaviour, unchanged).
//
// Flags: --repo <worktree> (required) · --lane N (port = portBase+N; or --port)
//        --routes a,b,c (default: config defaultRoutes) · --out <dir> (relative to --repo)
//        --devices iphone,desktop (default both) · --settle ms (default: config settleMs)
//        --no-full (skip full-page shots) · --full-max px (default 4000) · --json
//        --config <file> (instead of <repo>/.hub-visual.json) · --print-config
//
// Evidence naming: <route-slug>-<device>-fold.jpg / -full.jpg, report.json,
// report.md (route "/" → "home"; others lower-cased, non-alphanumerics → "-").
// JPEG q70 keeps a 390 full page ~150–400 KB; the report lists every file's
// size so the worker's zero-bloat check can read it.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

// ── configuration ─────────────────────────────────────────────────────────
// beatpath's profile is the script's original, hard-coded behaviour: it is
// what a repo with frontend/ and no .hub-visual.json gets, so evidence from
// before the config file existed stays reproducible.
const BOUNDARY_DEFAULT = ['This page didn’t load', "This page didn't load", 'Something on our end broke', 'couldn’t load', "couldn't load"]
const GENERIC = {
  delegate: null, appDir: null, serverJs: null, portBase: 3100, defaultRoutes: ['/'], envFiles: [], env: {},
  hostMappings: [], denyHosts: [], launchArgs: [],
  playwrightFrom: ['${LANE_VISUAL_CAPTURE_DIR:-}', '{repo}', '{app}', '{main}'],
  ignoreConsole: [], errorBoundaryText: BOUNDARY_DEFAULT, minTextChars: 200, minTextCharsByRoute: {}, failOnHttpStatus: null, settleMs: 6000,
}
const BEATPATH_PROFILE = {
  ...GENERIC,
  appDir: 'frontend', serverJs: 'frontend/server.js',
  envFiles: ['{app}/.env.local'],
  env: { CONVEX_URL: '${LANE_VISUAL_CONVEX_URL:-http://127.0.0.1:3210}' },
  hostMappings: ['beatpath-api.local', 'beatpath.local'],
  playwrightFrom: ['${LANE_VISUAL_CAPTURE_DIR:-/home/mdv/code/beatpath/tools/capture}'],
  ignoreConsole: ['clerk'],
}
function loadConfig(repo, explicit) {
  const path = explicit ? resolve(explicit) : join(repo, '.hub-visual.json')
  if (!existsSync(path)) {
    if (explicit) die(`--config ${path} not found`)
    if (existsSync(join(repo, 'frontend'))) return { ...BEATPATH_PROFILE, source: 'built-in beatpath profile (no .hub-visual.json, frontend/ present)' }
    return { ...GENERIC, appDir: '.', source: 'defaults (no .hub-visual.json)' }
  }
  let raw
  try { raw = JSON.parse(readFileSync(path, 'utf8')) } catch (e) { die(`${path}: ${e.message}`) }
  const unknown = Object.keys(raw).filter((k) => !(k in GENERIC) && !k.startsWith('_') && k !== '$comment')
  if (unknown.length) die(`${path}: unknown key(s) ${unknown.join(', ')}`)
  const cfg = { ...GENERIC, ...raw, source: path }
  if (!cfg.appDir) {
    const fe = join(repo, 'frontend')
    cfg.appDir = existsSync(join(fe, '.next')) || readdirSafe(fe).some((f) => f.startsWith('next.config.')) ? 'frontend' : '.'
  }
  for (const h of cfg.hostMappings) if (!/^[a-z0-9.-]+$/i.test(h)) die(`${path}: hostMappings entry "${h}" is not a bare host name`)
  return cfg
}
function mainCheckout(repo) {
  try {
    const common = execFileSync('git', ['-C', repo, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { encoding: 'utf8' }).trim()
    return dirname(common)
  } catch { return repo }
}
function expand(v, vars) {
  return String(v)
    .replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/gi, (_, k, d) => process.env[k] || d || '')
    .replace(/\{(repo|main|app|lane|port)\}/g, (_, k) => vars[k])
}
function readdirSafe(d) { try { return readdirSync(d) } catch { return [] } }
function hostOf(u) { try { return new URL(u).hostname.toLowerCase() } catch { return null } }

const args = parseArgs(process.argv.slice(2))
const REPO = args.repo ? resolve(args.repo) : null
if (!REPO || !existsSync(REPO)) die('--repo <worktree> is required')
const LANE = Number(args.lane ?? 0)
const CFG = loadConfig(REPO, args.config)
if (CFG.delegate && !args['print-config']) {
  const target = resolve(REPO, CFG.delegate)
  if (!existsSync(target)) die(`delegate ${target} (from ${CFG.source}) does not exist`)
  const r = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
  process.exit(r.status ?? 2)
}
const APP = resolve(REPO, CFG.appDir)
const PORT = Number(args.port ?? CFG.portBase + LANE)
const X = (v) => expand(v, { repo: REPO, main: mainCheckout(REPO), app: APP, lane: String(LANE), port: String(PORT) })
const ROUTES = (args.routes ? String(args.routes).split(',') : CFG.defaultRoutes).map((r) => r.trim()).filter(Boolean)
const OUT = resolve(REPO, String(args.out ?? 'lane-visual-out'))
const DEVICES = String(args.devices ?? 'iphone,desktop').split(',').map((d) => d.trim())
const SETTLE = Number(args.settle ?? CFG.settleMs)
const FULL = !args['no-full']
const TAP_MIN = 44
const FULL_MAX_PX = Number(args['full-max'] ?? 4000)
const IGNORE_CONSOLE = CFG.ignoreConsole.map((r) => new RegExp(r, 'i'))
const BOUNDARY = new RegExp(CFG.errorBoundaryText.join('|'), 'i')
const DENY = CFG.denyHosts.map((h) => h.toLowerCase())
if (args['print-config']) { process.stdout.write(JSON.stringify({ ...CFG, resolvedApp: APP, port: PORT, main: mainCheckout(REPO) }, null, 2) + '\n'); process.exit(0) }
process.stderr.write(`lane-visual: config ${CFG.source} · app ${APP} · port ${PORT}\n`)

// Playwright: the first of `playwrightFrom` that resolves it. beatpath's
// profile uses the main repo's tools/capture install (it carries the chromium
// this script launches); other repos use their own devDependency.
let chromium, devices
{
  const tried = []
  for (const dir of CFG.playwrightFrom.map(X).filter(Boolean)) {
    const req = createRequire(join(dir, 'package.json'))
    for (const name of ['playwright', '@playwright/test']) {
      try { ;({ chromium, devices } = req(name)); break } catch { /* next */ }
    }
    if (chromium) break
    tried.push(dir)
  }
  if (!chromium) die(`playwright not found under ${tried.join(', ')}`)
}

if (!existsSync(join(APP, '.next'))) die(`no ${join(APP, '.next')} — run the next build gate first`)
mkdirSync(OUT, { recursive: true })

const server = await startNext(REPO, PORT)
const report = { repo: REPO, port: PORT, startedAt: new Date().toISOString(), routes: [], ok: true }
try {
  const launchArgs = [...CFG.launchArgs.map(X)]
  if (CFG.hostMappings.length) launchArgs.unshift(`--host-resolver-rules=${CFG.hostMappings.map((h) => `MAP ${h} 127.0.0.1`).join(', ')}`)
  const browser = await chromium.launch({ args: launchArgs })
  for (const route of ROUTES) {
    for (const device of DEVICES) {
      const entry = await probe(browser, route, device)
      report.routes.push(entry)
      if (!entry.ok) report.ok = false
      process.stderr.write(`${entry.ok ? 'ok  ' : 'FAIL'} ${route} @${device}  ${entry.problems.join('; ') || ''}\n`)
    }
  }
  await browser.close()
} finally {
  server.kill('SIGTERM')
}

report.finishedAt = new Date().toISOString()
writeFileSync(join(OUT, 'report.json'), JSON.stringify(report, null, 2))
writeFileSync(join(OUT, 'report.md'), renderMd(report))
if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n')
else process.stdout.write(`${report.ok ? 'PASS' : 'FAIL'} — evidence in ${OUT} (${report.routes.length} shots)\n`)
process.exit(report.ok ? 0 : 1)

// ── probe one route on one device ────────────────────────────────────────
async function probe(browser, route, device) {
  const ctxOpts =
    device === 'iphone'
      ? { ...devices['iPhone 13'] }
      : { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 }
  const ctx = await browser.newContext(ctxOpts)
  const page = await ctx.newPage()
  const pageErrors = [], consoleErrors = [], failedRequests = [], blockedRequests = []
  if (DENY.length) {
    await ctx.route('**/*', (r) => {
      const host = hostOf(r.request().url())
      if (host && DENY.some((d) => (d.startsWith('*.') ? host.endsWith(d.slice(1)) || host === d.slice(2) : host === d))) {
        blockedRequests.push(r.request().url().slice(0, 140))
        return r.abort('blockedbyclient')
      }
      return r.continue()
    })
  }
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (IGNORE_CONSOLE.some((re) => re.test(t))) return // e.g. beatpath: Clerk refuses the non-canonical origin signed-out; not a page defect
    consoleErrors.push(t.slice(0, 300))
  })
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? ''
    if (f === 'net::ERR_ABORTED') return // prefetches cancelled by navigation
    if (f === 'net::ERR_BLOCKED_BY_CLIENT' && blockedRequests.length) return // a denyHosts abort, listed separately
    failedRequests.push(`${r.url().slice(0, 140)} ${f}`)
  })

  const url = `http://localhost:${PORT}${route}`
  const slug = route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const entry = { route, device, url, ok: true, problems: [], files: [], metrics: {}, pageErrors, consoleErrors, failedRequests }
  if (DENY.length) entry.blockedRequests = blockedRequests
  const t0 = Date.now()
  try {
    const resp = await page.goto(url, { waitUntil: 'load', timeout: 90_000 })
    entry.metrics.status = resp?.status() ?? null
    if ((resp?.status() ?? 0) >= 500) entry.serverLogTail = server.log().slice(-600)
    entry.metrics.finalUrl = page.url()
  } catch (e) {
    entry.problems.push(`goto failed: ${String(e).slice(0, 160)}`)
    entry.ok = false
    await ctx.close()
    return entry
  }
  await page.waitForTimeout(SETTLE)
  entry.metrics.loadMs = Date.now() - t0

  const m = await page.evaluate(([tapMin, boundaryRe]) => {
    const de = document.documentElement
    const main = document.querySelector('main') ?? document.body
    const mainRect = main.getBoundingClientRect()
    const text = (document.body.innerText || '').trim()
    const boundary = new RegExp(boundaryRe, 'i').test(text)
    // Primary tap targets: links and buttons inside <main> that are visible
    const small = []
    for (const el of main.querySelectorAll('a, button')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      if (r.height < tapMin && r.width < tapMin) {
        small.push(`${el.tagName.toLowerCase()}[${(el.getAttribute('aria-label') || el.textContent || '').trim().slice(0, 24)}] ${Math.round(r.width)}x${Math.round(r.height)}`)
      }
    }
    // Inset: the leftmost visible text node's x inside main
    let inset = null
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_TEXT)
    let n
    while ((n = walker.nextNode())) {
      if (!n.textContent.trim()) continue
      const range = document.createRange(); range.selectNodeContents(n)
      const r = range.getBoundingClientRect()
      // skip visually-hidden / off-canvas text (skip links at x<0, clipped sr-only)
      if (r.width === 0 || r.left < 0 || r.left >= innerWidth || r.bottom < 0) continue
      inset = inset === null ? r.left : Math.min(inset, r.left)
      if (inset <= 0) break
    }
    return {
      scrollWidth: de.scrollWidth, innerWidth: innerWidth, scrollHeight: de.scrollHeight,
      mainHeight: Math.round(mainRect.height), textChars: text.length, errorBoundary: boundary,
      smallTargets: small.slice(0, 12), smallTargetCount: small.length, minTextInset: inset === null ? null : Math.round(inset),
    }
  }, [TAP_MIN, BOUNDARY.source])
  entry.metrics = { ...entry.metrics, ...m }

  if (CFG.failOnHttpStatus != null && (entry.metrics.status ?? 0) >= CFG.failOnHttpStatus) { entry.problems.push(`HTTP ${entry.metrics.status}`); entry.ok = false }
  if (m.scrollWidth > m.innerWidth) { entry.problems.push(`horizontal overflow: scrollWidth ${m.scrollWidth} > ${m.innerWidth}`); entry.ok = false }
  if (m.errorBoundary) { entry.problems.push('route error boundary rendered'); entry.ok = false }
  if (pageErrors.length) { entry.problems.push(`${pageErrors.length} page error(s)`); entry.ok = false }
  if (consoleErrors.length) { entry.problems.push(`${consoleErrors.length} console error(s)`) /* reported, not fatal */ }
  const minText = CFG.minTextCharsByRoute[route.split('?')[0]] ?? CFG.minTextChars
  if (m.textChars < minText) { entry.problems.push(`thin page: ${m.textChars} chars of text`); entry.ok = false }
  if (device === 'iphone' && m.minTextInset !== null && m.minTextInset < 12) { entry.problems.push(`no page inset: text starts at x=${m.minTextInset}`); entry.ok = false }
  if (device === 'iphone' && m.smallTargetCount > 0) { entry.problems.push(`${m.smallTargetCount} tap target(s) under ${TAP_MIN}px (reported, not fatal)`) }
  if (blockedRequests.length) { entry.problems.push(`${blockedRequests.length} request(s) to denied hosts blocked (reported, not fatal)`) }

  const fold = join(OUT, `${slug}-${device}-fold.jpg`)
  await page.screenshot({ path: fold, type: 'jpeg', quality: 70 })
  entry.files.push(fileRow(fold))
  if (FULL) {
    // "Full" is the first FULL_MAX_PX of the page, not the whole river: a
    // 390px events page runs 25k px and 4 MB, which is noise as evidence.
    const full = join(OUT, `${slug}-${device}-full.jpg`)
    const vw = device === 'iphone' ? 390 : 1440
    const h = Math.min(m.scrollHeight, FULL_MAX_PX)
    await page.screenshot({ path: full, type: 'jpeg', quality: 60, fullPage: true, clip: { x: 0, y: 0, width: vw, height: h } })
    entry.files.push(fileRow(full))
  }
  await ctx.close()
  return entry
}

// ── the lane's own build, served the way the container serves it ────────
// next.config has `output: "standalone"` (`next start` refuses it): the
// container runs `node <serverJs>` from `.next/standalone` with `.next/static`
// and `public` staged beside server.js (beatpath:
// deploy/omarchy/frontend.Dockerfile:56-60; newjerseybrews: Dockerfile runner
// stage). Stage the same with symlinks inside the lane's own .next
// (gitignored), and give the server the runtime env the container gets: the
// config's envFiles, then its env (beatpath: frontend/.env.local plus
// CONVEX_URL pointed at the box's Convex, because the browser-facing
// NEXT_PUBLIC_CONVEX_URL is an mDNS name this Node process cannot resolve —
// lib/convexServer.ts says the same).
async function startNext(repo, port) {
  if (await portOpen(port)) die(`port ${port} already in use — another lane probe running? pass --port`)
  const standalone = join(APP, '.next', 'standalone')
  const rel = CFG.serverJs ?? [ 'server.js', join(CFG.appDir, 'server.js') ].find((p) => existsSync(join(standalone, p))) ?? 'server.js'
  const serverJs = join(standalone, rel)
  if (!existsSync(serverJs)) die(`no ${serverJs} — the build is not standalone or did not finish`)
  const serverDir = dirname(serverJs)
  linkInto(join(serverDir, '.next', 'static'), join(APP, '.next', 'static'))
  if (existsSync(join(APP, 'public'))) linkInto(join(serverDir, 'public'), join(APP, 'public'))
  const fileEnv = {}
  for (const f of CFG.envFiles.map(X)) Object.assign(fileEnv, readEnvFile(f))
  const cfgEnv = Object.fromEntries(Object.entries(CFG.env).map(([k, v]) => [k, X(String(v))]))
  const env = {
    ...process.env,
    ...fileEnv,
    NODE_ENV: 'production',
    PORT: String(port),
    // `localhost`, not 127.0.0.1: Next's router relativizes a middleware
    // rewrite against `http://<HOSTNAME>:<port>`, and Clerk's rewrite names
    // localhost — any other value turns it into an external proxy to itself
    // ("Failed to proxy … socket hang up", every route 500).
    HOSTNAME: 'localhost',
    ...cfgEnv,
  }
  const child = spawn(process.execPath, [rel], { cwd: standalone, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  child.log = () => log
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) die(`${rel} exited ${child.exitCode}:\n${log.slice(-800)}`)
    if (await portOpen(port)) return child
    await sleep(500)
  }
  child.kill('SIGTERM')
  die(`${rel} did not open :${port} within 60s:\n${log.slice(-800)}`)
}

function linkInto(linkPath, target) {
  if (existsSync(linkPath)) return
  mkdirSync(join(linkPath, '..'), { recursive: true })
  symlinkSync(target, linkPath, 'dir')
}

function readEnvFile(path) {
  if (!existsSync(path)) return {}
  const out = {}
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq === -1) continue
    const k = line.slice(0, eq).trim()
    let v = line.slice(eq + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[k] = v
  }
  return out
}

function portOpen(port) {
  return new Promise((res) => {
    const s = net.createConnection({ port, host: 'localhost' })
    s.once('connect', () => { s.destroy(); res(true) })
    s.once('error', () => res(false))
  })
}

// ── helpers ───────────────────────────────────────────────────────────────
function fileRow(path) { return { path, bytes: statSync(path).size } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
function die(msg) { process.stderr.write(`lane-visual: ${msg}\n`); process.exit(2) }
function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (v === undefined || v.startsWith('--')) out[k] = true
    else { out[k] = v; i++ }
  }
  return out
}
function renderMd(r) {
  const lines = [`# lane-visual report — ${r.ok ? 'PASS' : 'FAIL'}`, '', `repo: ${r.repo} · port ${r.port} · ${r.startedAt}`, '']
  for (const e of r.routes) {
    lines.push(`## ${e.route} @ ${e.device} — ${e.ok ? 'ok' : 'FAIL'}`)
    const m = e.metrics
    lines.push(`- status ${m.status} · load ${m.loadMs} ms · ${m.textChars} chars · scroll ${m.scrollWidth}/${m.innerWidth} w, ${m.scrollHeight} h · min text inset ${m.minTextInset}px · small targets ${m.smallTargetCount}`)
    if (e.problems.length) lines.push(`- problems: ${e.problems.join('; ')}`)
    if (e.pageErrors.length) lines.push(`- page errors: ${e.pageErrors.join(' | ')}`)
    if (e.consoleErrors.length) lines.push(`- console errors: ${e.consoleErrors.slice(0, 5).join(' | ')}`)
    if (e.failedRequests.length) lines.push(`- failed requests: ${e.failedRequests.slice(0, 5).join(' | ')}`)
    if (e.serverLogTail) lines.push('- server log tail: ' + e.serverLogTail.replace(/\n/g, ' ⏎ ').slice(-400))
    if (m.smallTargets?.length) lines.push(`- smallest targets: ${m.smallTargets.join(', ')}`)
    for (const f of e.files) lines.push(`- ${f.path.split('/').pop()} (${Math.round(f.bytes / 1024)} KB)`)
    lines.push('')
  }
  return lines.join('\n')
}
