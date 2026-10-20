#!/usr/bin/env node
// lane-visual — visual acceptance for a hub lane's OWN frontend build.
//
// Serves the lane's standalone build (`node .next/standalone/frontend/server.js`) on a per-lane port (the lane's
// `next build` gate must already have run), then for every route × device
// (iPhone 13 @ 390 and desktop @ 1440) loads the page signed-out, records
// page errors / console errors / failed requests, checks the mobile
// invariants, and writes fold + full-page JPEGs plus a report to the
// evidence dir. Exit code 1 when any invariant fails. Never points at the
// LAN or beta hosts: the browser talks to 127.0.0.1:<port> and, for the
// Convex client, to beatpath-api.local mapped onto 127.0.0.1 (nginx → the
// box's Convex; reads only, signed out).
//
//   node ~/.claude/scripts/lane-visual.mjs \
//     --repo /home/mdv/code/beatpath-lanes/lane-3 --lane 3 \
//     --routes /,/coverage --out openspec/changes/<change>/evidence/<task>
//
// Flags: --repo <worktree> (required) · --lane N (port = 3100+N; or --port)
//        --routes a,b,c (default /) · --out <dir> (relative to --repo)
//        --devices iphone,desktop (default both) · --settle ms (default 6000)
//        --no-full (skip full-page shots) · --full-max px (default 4000) · --json
//
// Evidence naming: <route-slug>-<device>-fold.jpg / -full.jpg, report.json,
// report.md. JPEG q70 keeps a 390 full page ~150–400 KB; the report lists
// every file's size so the worker's zero-bloat check can read it.

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'

const args = parseArgs(process.argv.slice(2))
const REPO = args.repo ? resolve(args.repo) : null
if (!REPO || !existsSync(join(REPO, 'frontend'))) die('--repo <worktree with frontend/> is required')
const LANE = Number(args.lane ?? 0)
const PORT = Number(args.port ?? 3100 + LANE)
const ROUTES = String(args.routes ?? '/').split(',').map((r) => r.trim()).filter(Boolean)
const OUT = resolve(REPO, String(args.out ?? 'lane-visual-out'))
const DEVICES = String(args.devices ?? 'iphone,desktop').split(',').map((d) => d.trim())
const SETTLE = Number(args.settle ?? 6000)
const FULL = !args['no-full']
const TAP_MIN = 44
const FULL_MAX_PX = Number(args['full-max'] ?? 4000)

// Playwright comes from the main repo's tools/capture install — lanes share
// the box, and that install carries the chromium this script launches.
const CAPTURE_DIR = process.env.LANE_VISUAL_CAPTURE_DIR ?? '/home/mdv/code/beatpath/tools/capture'
const requireFromCapture = createRequire(join(CAPTURE_DIR, 'package.json'))
let chromium, devices
try {
  ;({ chromium, devices } = requireFromCapture('playwright'))
} catch (e) {
  die(`playwright not found under ${CAPTURE_DIR}: ${e.message}`)
}

if (!existsSync(join(REPO, 'frontend', '.next'))) die(`no frontend/.next in ${REPO} — run the next build gate first`)
mkdirSync(OUT, { recursive: true })

const server = await startNext(REPO, PORT)
const report = { repo: REPO, port: PORT, startedAt: new Date().toISOString(), routes: [], ok: true }
try {
  const browser = await chromium.launch({
    args: ['--host-resolver-rules=MAP beatpath-api.local 127.0.0.1, MAP beatpath.local 127.0.0.1'],
  })
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
  const pageErrors = [], consoleErrors = [], failedRequests = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 300)))
  page.on('console', (m) => {
    if (m.type() !== 'error') return
    const t = m.text()
    if (/clerk/i.test(t)) return // Clerk refuses the non-canonical origin signed-out; not a page defect
    consoleErrors.push(t.slice(0, 300))
  })
  page.on('requestfailed', (r) => {
    const f = r.failure()?.errorText ?? ''
    if (f === 'net::ERR_ABORTED') return // prefetches cancelled by navigation
    failedRequests.push(`${r.url().slice(0, 140)} ${f}`)
  })

  const url = `http://localhost:${PORT}${route}`
  const slug = route === '/' ? 'home' : route.replace(/^\//, '').replace(/[^a-z0-9]+/gi, '-').toLowerCase()
  const entry = { route, device, url, ok: true, problems: [], files: [], metrics: {}, pageErrors, consoleErrors, failedRequests }
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

  const m = await page.evaluate((tapMin) => {
    const de = document.documentElement
    const main = document.querySelector('main') ?? document.body
    const mainRect = main.getBoundingClientRect()
    const text = (document.body.innerText || '').trim()
    const boundary = /This page didn’t load|This page didn't load|Something on our end broke|couldn’t load|couldn't load/i.test(text)
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
  }, TAP_MIN)
  entry.metrics = { ...entry.metrics, ...m }

  if (m.scrollWidth > m.innerWidth) { entry.problems.push(`horizontal overflow: scrollWidth ${m.scrollWidth} > ${m.innerWidth}`); entry.ok = false }
  if (m.errorBoundary) { entry.problems.push('route error boundary rendered'); entry.ok = false }
  if (pageErrors.length) { entry.problems.push(`${pageErrors.length} page error(s)`); entry.ok = false }
  if (consoleErrors.length) { entry.problems.push(`${consoleErrors.length} console error(s)`) /* reported, not fatal */ }
  if (m.textChars < 200) { entry.problems.push(`thin page: ${m.textChars} chars of text`); entry.ok = false }
  if (device === 'iphone' && m.minTextInset !== null && m.minTextInset < 12) { entry.problems.push(`no page inset: text starts at x=${m.minTextInset}`); entry.ok = false }
  if (device === 'iphone' && m.smallTargetCount > 0) { entry.problems.push(`${m.smallTargetCount} tap target(s) under ${TAP_MIN}px (reported, not fatal)`) }

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
// container runs `node frontend/server.js` from `.next/standalone` with
// `frontend/.next/static` and `frontend/public` staged beside it
// (deploy/omarchy/frontend.Dockerfile:56-60). Stage the same with symlinks
// inside the lane's own .next (gitignored), and give the server the runtime
// env the container gets: frontend/.env.local plus CONVEX_URL pointed at the
// box's Convex, because the browser-facing NEXT_PUBLIC_CONVEX_URL is an mDNS
// name this Node process cannot resolve (lib/convexServer.ts says the same).
async function startNext(repo, port) {
  if (await portOpen(port)) die(`port ${port} already in use — another lane probe running? pass --port`)
  const fe = join(repo, 'frontend')
  const standalone = join(fe, '.next', 'standalone')
  const serverJs = join(standalone, 'frontend', 'server.js')
  if (!existsSync(serverJs)) die(`no ${serverJs} — the build is not standalone or did not finish`)
  linkInto(join(standalone, 'frontend', '.next', 'static'), join(fe, '.next', 'static'))
  linkInto(join(standalone, 'frontend', 'public'), join(fe, 'public'))
  const env = {
    ...process.env,
    ...readEnvFile(join(fe, '.env.local')),
    NODE_ENV: 'production',
    PORT: String(port),
    // `localhost`, not 127.0.0.1: Next's router relativizes a middleware
    // rewrite against `http://<HOSTNAME>:<port>`, and Clerk's rewrite names
    // localhost — any other value turns it into an external proxy to itself
    // ("Failed to proxy … socket hang up", every route 500).
    HOSTNAME: 'localhost',
    CONVEX_URL: process.env.LANE_VISUAL_CONVEX_URL ?? 'http://127.0.0.1:3210',
  }
  const child = spawn(process.execPath, ['frontend/server.js'], { cwd: standalone, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  child.log = () => log
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) die(`server.js exited ${child.exitCode}:\n${log.slice(-800)}`)
    if (await portOpen(port)) return child
    await sleep(500)
  }
  child.kill('SIGTERM')
  die(`server.js did not open :${port} within 60s:\n${log.slice(-800)}`)
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
