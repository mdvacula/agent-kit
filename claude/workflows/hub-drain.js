export const meta = {
  name: 'hub-drain',
  description: 'Drain pending Task Hub tasks for a project across parallel lanes (one git worktree each, one change per lane at a time): tiered worker → opus review → fix cycles → rebase+ff-merge+push per task. Owner-gated stops are recorded and skipped, never end the run.',
  whenToUse: 'After /hub-plan has synced tasks. args: {project, change?, maxTasks?, repo?, lanes?, laneOffset?}',
  phases: [
    { title: 'Preflight', detail: 'hub health, clean main checkout, pull --rebase' },
    { title: 'Lanes', detail: 'one worktree per lane, deps + ignored inputs, reset to main' },
    { title: 'Queue', detail: 'runnable tasks computed in the shell, a handful of rows' },
    { title: 'Implement', detail: 'one tiered hub-worker per task in its lane worktree' },
    { title: 'Review', detail: 'opus hub-reviewer, max 2 fix cycles' },
    { title: 'Land', detail: 'runLog + rebase onto main + ff-merge + push, serialised across lanes' },
  ],
}

// ── args (tolerate stringified JSON / loose object literals) ────────────────
function normalizeArgs(raw) {
  if (raw == null || typeof raw === 'object') return raw
  if (typeof raw !== 'string') return null
  try { return JSON.parse(raw) } catch {}
  const keyed = raw.replace(/([{,]\s*)([A-Za-z_]\w*)\s*:/g, '$1"$2":')
  try { return JSON.parse(keyed) } catch {}
  try { return JSON.parse(keyed.replace(/'/g, '"')) } catch { return null }
}
const A = normalizeArgs(args)
const project = A && A.project
if (!project) return { error: `args.project is required, e.g. {project: "newjerseybrews"} — received ${typeof args}: ${String(args).slice(0, 120)}` }
const repo = A.repo || `/home/mdv/code/${project}`
const change = A.change
const maxTasks = A.maxTasks || 1000
const LANES = Math.max(1, Math.min(6, A.lanes || 3))
const OFFSET = Math.max(0, A.laneOffset || 0) // lane numbers start at OFFSET+1 so two drains can run side by side

const HUB = 'http://127.0.0.1:8050'
const SCRIPTS = '/home/mdv/.claude/workflows'
const TIER_AGENT = { haiku: 'hub-worker-haiku', sonnet: 'hub-worker', opus: 'hub-worker-opus' }
const TIER_UP = { haiku: 'sonnet', sonnet: 'opus', opus: 'opus' }

const QUEUE_SCHEMA = {
  type: 'object', required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object', required: ['id', 'title', 'status'],
        properties: {
          id: { type: 'string' }, title: { type: 'string' }, status: { type: 'string' },
          change: { type: ['string', 'null'] },
          priority: { type: ['string', 'null'] }, tier: { type: ['string', 'null'] },
          touches: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
}
const WORKER_SCHEMA = {
  type: 'object', required: ['outcome', 'summary'],
  properties: {
    outcome: { type: 'string', enum: ['completed', 'blocked'] },
    commitRange: { type: ['string', 'null'] },
    summary: { type: 'string' },
    gates: { type: ['string', 'null'] },
    blockReason: { type: ['string', 'null'] },
  },
}
const VERDICT_SCHEMA = {
  type: 'object', required: ['verdict', 'findings'],
  properties: {
    verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
    findings: {
      type: 'array',
      items: {
        type: 'object', required: ['file', 'severity', 'issue', 'requiredFix'],
        properties: {
          file: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          issue: { type: 'string' }, requiredFix: { type: 'string' },
        },
      },
    },
    notes: { type: ['string', 'null'] },
  },
}
const SHELL_SCHEMA = {
  type: 'object', required: ['ok', 'output'],
  properties: { ok: { type: 'boolean' }, output: { type: 'string' } },
}

// A tiny shell runner: haiku, low effort, returns the command's output
// verbatim. Every git operation a lane needs lives in a deterministic script
// under ~/.claude/workflows so no model improvises git.
async function sh(cmd, label, phaseName) {
  const r = await agent(
    `Run EXACTLY this command and return {ok: <exit status was 0>, output: <stdout+stderr, unchanged, last 4000 chars>}:\n${cmd}\n` +
    `Do not retry, do not fix, do not run anything else.`,
    { model: 'haiku', effort: 'low', phase: phaseName, label, schema: SHELL_SCHEMA },
  )
  return r || { ok: false, output: 'shell agent died' }
}

// ── Queue: runnable set computed in the shell, a handful of rows ────────────
// (a 150-task JSON blob through a model was slow — 3.5 min per fetch — and
// truncation-prone: blockers falling outside the returned list made every
// task look blocked and ended runs early with work still runnable)
async function fetchRunnable(laneLabel) {
  // One plain command, no inline quoting: the script computes the runnable set
  // and the agent copies its stdout. A flaky inline python -c once returned
  // {tasks: []} for a lane at startup and retired it with 17 tasks runnable.
  const cmd = `python3 ${SCRIPTS}/hub-queue.py --project ${project}${change ? ` --change ${change}` : ''} --hub ${HUB}`
  const r = await agent(
    `Run EXACTLY this command and return its stdout as your JSON result, unchanged:\n${cmd}\n` +
    `Rules: do NOT retype, summarize, invent, rename, or infer any task. Ids must be copied byte-for-byte. ` +
    `If the command itself cannot be run, return {tasks: [], error: "<why>"}.`,
    { model: 'haiku', effort: 'low', phase: 'Queue', label: `queue:${laneLabel}`, schema: QUEUE_SCHEMA },
  )
  return r ? r.tasks : null
}

// ── Shared lane state (single JS thread: no races between awaits) ───────────
const claimed = new Set()          // task ids taken by some lane this run
const running = new Map()          // task id → {change, touches[]} for every task in flight
const completed = []
const blocked = []
let mergeChain = Promise.resolve() // serialises rebase+merge+push across lanes
let busy = 0
let wakeWaiters = []
function wake() { const w = wakeWaiters; wakeWaiters = []; w.forEach(fn => fn()) }
function waitForChange() { return new Promise(res => wakeWaiters.push(res)) }
function withMergeLock(fn) {
  const run = mergeChain.then(fn, fn)
  mergeChain = run.catch(() => {})
  return run
}
// Collision rule. A task that declares `touches` (path prefixes it edits — set
// by /hub-plan) may run beside anything whose touches do not overlap, even in
// the same change. A task without `touches` is opaque: it takes a change-wide
// lock and cannot start while any task of that change is in flight.
function overlaps(a, b) {
  for (const x of a) for (const y of b) if (x.startsWith(y) || y.startsWith(x)) return true
  return false
}
function conflicts(t) {
  const mine = t.touches || []
  if (!mine.length) {
    // opaque task: needs its whole change free
    for (const r of running.values()) if (r.change && r.change === t.change) return true
    return false
  }
  for (const r of running.values()) {
    if (r.change === t.change && !(r.touches || []).length) return true // an opaque task holds the change
    if (overlaps(mine, r.touches || [])) return true
  }
  return false
}
function pickFor(rows) {
  for (const t of rows) {
    if (claimed.has(t.id)) continue
    if (conflicts(t)) continue
    return t
  }
  return null
}

// ── Preflight ───────────────────────────────────────────────────────────────
phase('Preflight')
const pre = await agent(
  `Preflight for a task drain on ${repo}. 1) curl -s ${HUB}/health — must return status ok. ` +
  `2) In ${repo}: git status --porcelain must show no tracked modifications (untracked files are OK); ` +
  `3) git pull --rebase (abort and report on conflict). ` +
  `Return {ok: boolean, detail: string}.`,
  { model: 'haiku', effort: 'low', phase: 'Preflight', label: 'preflight',
    schema: { type: 'object', required: ['ok', 'detail'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } } },
)
if (!pre || !pre.ok) return { stopped: 'preflight', detail: pre ? pre.detail : 'preflight agent failed' }

// ── One lane ────────────────────────────────────────────────────────────────
async function runLane(n) {
  const lane = `lane-${n}`
  const wt = `${repo}-lanes/${lane}`
  const setup = await sh(`bash ${SCRIPTS}/hub-lane-setup.sh ${repo} ${n}`, `setup:${lane}`, 'Lanes')
  if (!setup.ok || !/READY /.test(setup.output)) {
    log(`✗ ${lane} setup failed: ${setup.output.slice(-300)}`)
    return
  }
  log(`${lane} ready at ${wt}`)

  let emptyStrikes = 0
  for (;;) {
    if (completed.length >= maxTasks) return
    const rows = await fetchRunnable(lane)
    const task = rows ? pickFor(rows) : null
    if (!task) {
      // Nothing for this lane right now. Only retire when the queue is empty
      // on three consecutive fetches with nobody else working — a single empty
      // fetch is often a flaky agent run or a race with another lane's claim.
      emptyStrikes += 1
      if (busy === 0 && emptyStrikes >= 3) { log(`${lane} retiring: queue empty ×${emptyStrikes}`); return }
      if (busy > 0) await waitForChange()  // another lane may unlock files or complete a blocker
      continue
    }
    emptyStrikes = 0
    claimed.add(task.id)
    running.set(task.id, { change: task.change || null, touches: task.touches || [] })
    busy += 1
    try {
      await runTask(task, n, wt)
    } finally {
      running.delete(task.id)
      busy -= 1
      wake()
    }
  }
}

async function runTask(task, n, wt) {
  const lane = `lane-${n}`
  const tier = TIER_AGENT[task.tier] ? task.tier : 'sonnet'
  log(`▶ ${lane} ${task.id} [${task.priority || '—'}/${tier}]`)

  // fresh start for every task: lane branch reset to main (setup script is idempotent)
  const reset = await sh(`bash ${SCRIPTS}/hub-lane-setup.sh ${repo} ${n}`, `reset:${lane}`, 'Lanes')
  if (!reset.ok) { log(`✗ ${lane} reset failed before ${task.id}: ${reset.output.slice(-200)}`); return }

  let currentTier = tier
  let worker = await agent(
    `Run task ${task.id} ("${task.title}") in project repo ${wt} — this is a git worktree on branch ${lane}; treat it exactly as the project repo. Follow your full protocol.`,
    { agentType: TIER_AGENT[currentTier], phase: 'Implement', label: `${lane}:${task.id}`, schema: WORKER_SCHEMA },
  )
  if (!worker) { log(`✗ worker died on ${task.id}`); return }

  // Owner-gated stop: review any code half, land it if it passes, keep draining.
  if (worker.outcome === 'blocked') {
    log(`⏸ ${lane} ${task.id} blocked: ${(worker.blockReason || worker.summary || '').slice(0, 160)}`)
    let v = null
    if (worker.commitRange) {
      v = await agent(
        `Review task ${task.id} in ${wt}, commit range: ${worker.commitRange}. Follow your protocol. ` +
        `Scope note: the worker stopped on the Blocked path (${(worker.blockReason || '').slice(0, 300)}); ` +
        `review only the code it committed and do not fail the review for the owner-gated boxes being unticked.`,
        { agentType: 'hub-reviewer', phase: 'Review', label: `review-blocked:${task.id}`, schema: VERDICT_SCHEMA },
      )
    }
    let landed = null
    if (worker.commitRange && v && v.verdict === 'PASS') landed = await land(task, n)
    else if (worker.commitRange) await sh(`bash ${SCRIPTS}/hub-lane-park.sh ${repo} ${n} ${task.id}`, `park:${task.id}`, 'Land')
    await agent(
      `Job A: record a runLog entry on task ${task.id}. Entry JSON: ` +
      JSON.stringify({ agent: TIER_AGENT[currentTier], tier: currentTier, lane, commitRange: worker.commitRange || null,
        gates: worker.gates, outcome: 'blocked', blockReason: worker.blockReason || worker.summary,
        verdict: v ? v.verdict : null, findings: v ? v.findings : [], landed }),
      { agentType: 'hub-steward', phase: 'Land', label: `runlog-blocked:${task.id}` },
    )
    if (landed) {
      // The code half is reviewed and on main. Split the owner-executed remainder
      // into its own blocked child so code dependents stop waiting on a human step.
      const child = `${task.id}-owner-run`
      await agent(
        `Job D: split an owner-run remainder off task ${task.id}. Using mcp__task-hub__sync_task, create task id "${child}" ` +
        `(project "${project}", status "blocked") with title "OWNER OPS: finish the owner-executed boxes of ${task.id} — commands and context in notes; code half landed on main (${landed})" ` +
        `and metadata {change, specRef, priority, boxes copied from ${task.id}; type "chore"; tier "haiku"; blockedBy ["${task.id}"]; touches []; ` +
        `notes: ${JSON.stringify((worker.blockReason || worker.summary || '').slice(0, 1600))}}. ` +
        `Then mcp__task-hub__update_task_status(${task.id}, "completed", notes="Code half reviewed (${v.verdict}) and landed ${landed}; owner-executed remainder split into ${child}."). ` +
        `Return {ok, child}.`,
        { agentType: 'hub-steward', phase: 'Land', label: `split:${task.id}` },
      )
    }
    blocked.push({ id: task.id, lane, reason: worker.blockReason || worker.summary, commitRange: worker.commitRange || null,
      verdict: v ? v.verdict : null, findings: v ? v.findings : [], landed })
    return
  }

  // Review with up to two fix cycles; cycle 2 bumps the tier.
  let verdict = null
  let cycles = 0
  for (;;) {
    verdict = await agent(
      `Review task ${task.id} in ${wt}, commit range: ${worker.commitRange}. Follow your protocol.`,
      { agentType: 'hub-reviewer', phase: 'Review', label: `review:${task.id}`, schema: VERDICT_SCHEMA },
    )
    if (!verdict) { log(`✗ reviewer died on ${task.id}`); return }
    if (verdict.verdict === 'PASS') break
    if (cycles >= 2) {
      const reason = `Failed review after ${cycles} fix cycles. Findings: ` +
        verdict.findings.map(f => `${f.file} [${f.severity}] ${f.issue}`).join('; ')
      await agent(`Job C: mark task ${task.id} blocked. Reason: ${reason}`,
        { agentType: 'hub-steward', phase: 'Land', label: `block:${task.id}` })
      const park = await sh(`bash ${SCRIPTS}/hub-lane-park.sh ${repo} ${n} ${task.id}`, `park:${task.id}`, 'Land')
      log(`✗ ${lane} ${task.id} failed review after ${cycles} fix cycles — blocked, work parked (${park.output.trim().slice(0, 80)})`)
      blocked.push({ id: task.id, lane, reason, commitRange: worker.commitRange || null, verdict: 'FAIL', findings: verdict.findings, fixCycles: cycles })
      return
    }
    cycles += 1
    if (cycles === 2) currentTier = TIER_UP[currentTier]
    log(`↻ ${lane} fix cycle ${cycles} for ${task.id} (${currentTier})`)
    worker = await agent(
      `Fix-cycle for task ${task.id} in ${wt} (git worktree on branch ${lane}). Existing work is in commit range ${worker.commitRange}. ` +
      `Do NOT re-implement — address these review findings with follow-up commits:\n` +
      verdict.findings.filter(f => f.severity !== 'minor')
        .map(f => `- ${f.file} [${f.severity}]: ${f.issue} → ${f.requiredFix}`).join('\n'),
      { agentType: TIER_AGENT[currentTier], phase: 'Implement', label: `fix${cycles}:${task.id}`, schema: WORKER_SCHEMA },
    )
    if (!worker) { log(`✗ worker died in fix cycle on ${task.id}`); return }
    if (worker.outcome === 'blocked') {
      blocked.push({ id: task.id, lane, reason: worker.blockReason || worker.summary, commitRange: worker.commitRange || null, verdict: 'FAIL', findings: verdict.findings, fixCycles: cycles })
      await sh(`bash ${SCRIPTS}/hub-lane-park.sh ${repo} ${n} ${task.id}`, `park:${task.id}`, 'Land')
      return
    }
  }

  const landed = await land(task, n)
  await agent(
    `Job A: record a runLog entry on task ${task.id}. Entry JSON: ` +
    JSON.stringify({ agent: TIER_AGENT[currentTier], tier: currentTier, lane, commitRange: worker.commitRange,
      gates: worker.gates, verdict: verdict.verdict, findingsCount: verdict.findings.length,
      fixCycles: cycles, summary: worker.summary, landed }),
    { agentType: 'hub-steward', phase: 'Land', label: `runlog:${task.id}` },
  )
  completed.push({ id: task.id, lane, commitRange: worker.commitRange, fixCycles: cycles, landed })
}

// Rebase the lane onto main, fast-forward main, push — one lane at a time.
async function land(task, n) {
  return withMergeLock(async () => {
    const r = await sh(`bash ${SCRIPTS}/hub-lane-merge.sh ${repo} ${n}`, `merge:${task.id}`, 'Land')
    const m = /MERGED (\S+)/.exec(r.output)
    if (r.ok && m) { log(`✓ landed ${task.id} (${m[1]})`); return m[1] }
    log(`✗ landing ${task.id} failed: ${r.output.trim().slice(-200)}`)
    // A conflict needs a human: record it, park the commits, reset the lane.
    await agent(`Job C: mark task ${task.id} blocked. Reason: landing on main failed — ${r.output.trim().slice(-400)}`,
      { agentType: 'hub-steward', phase: 'Land', label: `block-land:${task.id}` })
    await sh(`bash ${SCRIPTS}/hub-lane-park.sh ${repo} ${n} ${task.id}`, `park:${task.id}`, 'Land')
    return null
  })
}

// ── Run the lanes ───────────────────────────────────────────────────────────
phase('Lanes')
await parallel(Array.from({ length: LANES }, (_, i) => () => runLane(OFFSET + i + 1)))

return {
  drained: completed.length, completed,
  blockedCount: blocked.length, blocked,
  lanes: LANES, project, change: change || null,
}
