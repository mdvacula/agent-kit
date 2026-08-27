export const meta = {
  name: 'hub-drain',
  description: 'Drain pending Task Hub tasks for a project: tiered worker → opus review → fix cycles → checkpoint push. Returns early on any blocker for user escalation.',
  whenToUse: 'After /hub-plan has synced tasks. args: {project, change?, maxTasks?, repo?}',
  phases: [
    { title: 'Preflight', detail: 'hub health, clean tree, pull --rebase' },
    { title: 'Queue', detail: 'fetch runnable tasks' },
    { title: 'Implement', detail: 'one tiered hub-worker per task, sequential' },
    { title: 'Review', detail: 'opus hub-reviewer, max 2 fix cycles' },
    { title: 'Record', detail: 'runLog entries via hub-steward' },
    { title: 'Push', detail: 'checkpoint pushes every 3 reviewed tasks' },
  ],
}

// ── args ────────────────────────────────────────────────────────────────────
const project = args && args.project
if (!project) return { error: 'args.project is required, e.g. {project: "newjerseybrews"}' }
const repo = (args && args.repo) || `/home/mdv/code/${project}`
const change = args && args.change
const maxTasks = (args && args.maxTasks) || 1000

const HUB = 'http://127.0.0.1:8050'
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
          priority: { type: ['string', 'null'] }, tier: { type: ['string', 'null'] },
          blockedBy: { type: 'array', items: { type: 'string' } },
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

async function fetchQueue() {
  const filter = change ? ` whose metadata.change == "${change}"` : ''
  const r = await agent(
    `Run: curl -s ${HUB}/tasks — this returns a JSON array of tasks. ` +
    `Select tasks where project == "${project}"${filter}. ` +
    `Return ALL matching tasks (every status) as {tasks:[{id,title,status,priority: metadata.priority, tier: metadata.tier, blockedBy: metadata.blockedBy||[]}]}. ` +
    `Do not truncate.`,
    { model: 'haiku', effort: 'low', phase: 'Queue', label: 'fetch-queue', schema: QUEUE_SCHEMA },
  )
  return r ? r.tasks : null
}

function pickNext(tasks) {
  const done = new Set(tasks.filter(t => t.status === 'completed').map(t => t.id))
  const rank = { P0: 0, P1: 1, P2: 2 }
  const runnable = tasks
    .filter(t => t.status === 'pending')
    .filter(t => (t.blockedBy || []).every(b => done.has(b)))
    .sort((a, b) => ((rank[a.priority] ?? 9) - (rank[b.priority] ?? 9)))
  return runnable[0] || null
}

async function steward(job, label) {
  return agent(job, { agentType: 'hub-steward', phase: label === 'push' ? 'Push' : 'Record', label: `steward:${label}` })
}

// ── Preflight ───────────────────────────────────────────────────────────────
phase('Preflight')
const pre = await agent(
  `Preflight for a task drain on ${repo}. 1) curl -s ${HUB}/health — must return status ok. ` +
  `2) In ${repo}: git status --porcelain must be empty (untracked files are OK to note but not fatal); ` +
  `3) git pull --rebase (abort and report on conflict). ` +
  `Return {ok: boolean, detail: string}.`,
  { model: 'haiku', effort: 'low', phase: 'Preflight', label: 'preflight',
    schema: { type: 'object', required: ['ok', 'detail'], properties: { ok: { type: 'boolean' }, detail: { type: 'string' } } } },
)
if (!pre || !pre.ok) return { stopped: 'preflight', detail: pre ? pre.detail : 'preflight agent failed' }

// ── Drain loop — strictly sequential, one task in flight ────────────────────
const completed = []
let sincePush = 0

while (completed.length < maxTasks) {
  const queue = await fetchQueue()
  if (!queue) return { stopped: 'queue-fetch-failed', completed }
  const task = pickNext(queue)
  if (!task) break

  const tier = TIER_AGENT[task.tier] ? task.tier : 'sonnet'
  log(`▶ ${task.id} [${task.priority || '—'}/${tier}]`)

  // implement (fix cycles respawn with findings; cycle 2 bumps the tier)
  let currentTier = tier
  let worker = await agent(
    `Run task ${task.id} ("${task.title}") in project repo ${repo}. Follow your full protocol.`,
    { agentType: TIER_AGENT[currentTier], phase: 'Implement', label: task.id, schema: WORKER_SCHEMA },
  )
  if (!worker) return { stopped: 'worker-died', task: task.id, completed }
  if (worker.outcome === 'blocked')
    return { stopped: 'task-blocked', task: task.id, reason: worker.blockReason || worker.summary, completed }

  let verdict = null
  let cycles = 0
  for (;;) {
    verdict = await agent(
      `Review task ${task.id} in ${repo}, commit range: ${worker.commitRange}. Follow your protocol.`,
      { agentType: 'hub-reviewer', phase: 'Review', label: `review:${task.id}`, schema: VERDICT_SCHEMA },
    )
    if (!verdict) return { stopped: 'reviewer-died', task: task.id, completed }
    if (verdict.verdict === 'PASS') break
    if (cycles >= 2) {
      const reason = `Failed review after ${cycles} fix cycles. Findings: ` +
        verdict.findings.map(f => `${f.file} [${f.severity}] ${f.issue}`).join('; ')
      await steward(`Job C: mark task ${task.id} blocked. Reason: ${reason}`, `block:${task.id}`)
      return { stopped: 'review-failed', task: task.id, findings: verdict.findings, completed }
    }
    cycles += 1
    if (cycles === 2) currentTier = TIER_UP[currentTier]
    log(`↻ fix cycle ${cycles} for ${task.id} (${currentTier})`)
    worker = await agent(
      `Fix-cycle for task ${task.id} in ${repo}. Existing work is in commit range ${worker.commitRange}. ` +
      `Do NOT re-implement — address these review findings with follow-up commits:\n` +
      verdict.findings.filter(f => f.severity !== 'minor')
        .map(f => `- ${f.file} [${f.severity}]: ${f.issue} → ${f.requiredFix}`).join('\n'),
      { agentType: TIER_AGENT[currentTier], phase: 'Implement', label: `fix${cycles}:${task.id}`, schema: WORKER_SCHEMA },
    )
    if (!worker) return { stopped: 'worker-died', task: task.id, completed }
    if (worker.outcome === 'blocked')
      return { stopped: 'task-blocked', task: task.id, reason: worker.blockReason || worker.summary, completed }
  }

  await steward(
    `Job A: record a runLog entry on task ${task.id}. Entry JSON: ` +
    JSON.stringify({
      agent: TIER_AGENT[currentTier], tier: currentTier, commitRange: worker.commitRange,
      gates: worker.gates, verdict: verdict.verdict, findingsCount: verdict.findings.length,
      fixCycles: cycles, summary: worker.summary,
    }),
    `runlog:${task.id}`,
  )

  completed.push({ id: task.id, commitRange: worker.commitRange, fixCycles: cycles })
  sincePush += 1
  if (sincePush >= 3) {
    const push = await steward(`Job B: checkpoint push for repo ${repo}.`, 'push')
    if (push === null) return { stopped: 'push-failed', completed }
    sincePush = 0
  }
}

// final push for any reviewed-but-unpushed work
if (sincePush > 0) await steward(`Job B: checkpoint push for repo ${repo}.`, 'push')

return { drained: completed.length, completed, project, change: change || null }
