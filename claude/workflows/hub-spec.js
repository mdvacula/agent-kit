export const meta = {
  name: 'hub-spec',
  description: 'Agentic spec development: parallel exploration → three competing approaches → judge → draft OpenSpec artifacts → adversarial critique → one revise cycle. Artifacts land on disk uncommitted for human review; no hub sync here.',
  whenToUse: 'Start of the loop, before /hub-plan. args: {project, idea, changeId?, repo?}',
  phases: [
    { title: 'Explore', detail: 'code map, spec conventions, constraints — in parallel' },
    { title: 'Approaches', detail: 'three lenses drafted independently, then judged' },
    { title: 'Draft', detail: 'write proposal/design/tasks per the repo OpenSpec schema' },
    { title: 'Critique', detail: 'adversarial critics: completeness, feasibility, task quality' },
    { title: 'Revise', detail: 'one fix cycle if critics found blockers' },
  ],
}

const project = args && args.project
const idea = args && args.idea
if (!project || !idea) return { error: 'args {project, idea} are required' }
const repo = (args && args.repo) || `/home/mdv/code/${project}`
const wantedChangeId = (args && args.changeId) || null

// ── Explore ─────────────────────────────────────────────────────────────────
phase('Explore')
const [codeMap, conventions, constraints] = await parallel([
  () => agent(
    `In ${repo}: map the code most relevant to this idea: "${idea}". ` +
    `Report: key files/modules with paths, patterns and utilities that should be reused, ` +
    `any existing partial implementation of this idea, and the test setup. ` +
    `Concise structured brief — you are feeding a design agent, not a human.`,
    { model: 'sonnet', phase: 'Explore', label: 'code-map' }),
  () => agent(
    `In ${repo}: read openspec/project.md, openspec/config.yaml (note the schema and any custom rules), ` +
    `the specs/ directory, and the active openspec/changes/. Also read CLAUDE.md and AGENTS.md. ` +
    `Report: the exact artifact conventions a new change must follow (file set, formats, checkbox style), ` +
    `which existing specs/changes overlap with: "${idea}", and the repo guardrails that bind implementation. ` +
    `Include the list of existing change IDs so a new ID can avoid collisions.`,
    { model: 'sonnet', phase: 'Explore', label: 'spec-conventions' }),
  () => agent(
    `In ${repo}: hunt for constraints and superseding decisions relevant to "${idea}": ` +
    `roadmap/backlog docs, ADRs, policy docs (e.g. data-source rules), recent commits that changed direction. ` +
    `Report what must NOT be done and why, with file references. If nothing constrains the idea, say so explicitly.`,
    { model: 'sonnet', phase: 'Explore', label: 'constraints' }),
])
if (!codeMap || !conventions) return { stopped: 'explore-failed', haveCodeMap: !!codeMap, haveConventions: !!conventions }
const context = `## Code map\n${codeMap}\n\n## Spec conventions & overlaps\n${conventions}\n\n## Constraints\n${constraints || 'none found'}`

// ── Approaches: three lenses, judged ────────────────────────────────────────
phase('Approaches')
const LENSES = [
  ['minimal', 'the smallest change that fully delivers the outcome — cut everything optional'],
  ['robust', 'the long-term-right architecture — edge cases, failure modes, growth'],
  ['leverage', 'maximum reuse of code and patterns that already exist in this repo'],
]
const approaches = (await parallel(LENSES.map(([name, lens]) => () => agent(
  `Design an implementation approach for "${idea}" in ${repo} strictly through this lens: ${lens}.\n\n${context}\n\n` +
  `Return: approach summary, key technical decisions with rationale, main risks, and a rough ordered task list. ` +
  `Stay honest to your lens even if it has costs — a judge will compare approaches.`,
  { model: 'sonnet', phase: 'Approaches', label: `approach:${name}` }),
))).filter(Boolean)
if (approaches.length === 0) return { stopped: 'no-approaches' }

const judgment = await agent(
  `You are judging ${approaches.length} independently-drafted approaches for "${idea}" in ${repo}.\n\n` +
  approaches.map((a, i) => `### Approach ${i + 1} (${LENSES[i] ? LENSES[i][0] : 'extra'})\n${a}`).join('\n\n') +
  `\n\n${context}\n\nPick the winner for THIS repo at ITS current stage, then graft in the best individual ideas ` +
  `from the losers. Return {winner, rationale, synthesis} where synthesis is the full merged approach a spec ` +
  `author can draft from without reading the originals.`,
  { model: 'opus', phase: 'Approaches', label: 'judge',
    schema: { type: 'object', required: ['winner', 'rationale', 'synthesis'],
      properties: { winner: { type: 'string' }, rationale: { type: 'string' }, synthesis: { type: 'string' } } } },
)
if (!judgment) return { stopped: 'judge-failed' }

// ── Draft artifacts ─────────────────────────────────────────────────────────
phase('Draft')
const DRAFT_SCHEMA = {
  type: 'object', required: ['changeId', 'files', 'summary'],
  properties: {
    changeId: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    validation: { type: ['string', 'null'] },
  },
}
const draftPrompt = (extra) =>
  `Author the OpenSpec change artifacts for "${idea}" in ${repo}.\n\n` +
  `Approach (already judged — follow it):\n${judgment.synthesis}\n\n${context}\n\n` +
  `Rules:\n` +
  `- Follow the repo's OpenSpec conventions EXACTLY (openspec/config.yaml schema; if .claude/skills/openspec-propose/SKILL.md exists, read it and follow its artifact structure).\n` +
  `- Change ID: ${wantedChangeId || 'derive a kebab-case ID consistent with existing change naming; avoid collisions'}.\n` +
  `- Write proposal.md, design.md, tasks.md (checkboxes grouped into coherent subsections — they become hub tasks later), and spec deltas if the schema calls for them, under openspec/changes/<changeId>/.\n` +
  `- tasks.md must include testing and docs work, not just feature code.\n` +
  `- If "npx --yes @fission-ai/openspec@latest validate <changeId>" works in this repo, run it and fix what it reports; record the output.\n` +
  `- Do NOT commit, do NOT touch code outside openspec/changes/<changeId>/.\n` +
  (extra || '') +
  `\nReturn {changeId, files (paths written), summary, validation}.`
let draft = await agent(draftPrompt(), { model: 'opus', phase: 'Draft', label: 'draft-artifacts', schema: DRAFT_SCHEMA })
if (!draft) return { stopped: 'draft-failed' }

// ── Adversarial critique ────────────────────────────────────────────────────
const CRIT_SCHEMA = {
  type: 'object', required: ['blockers', 'majors', 'minors'],
  properties: {
    blockers: { type: 'array', items: { type: 'string' } },
    majors: { type: 'array', items: { type: 'string' } },
    minors: { type: 'array', items: { type: 'string' } },
  },
}
async function critique() {
  phase('Critique')
  const dir = `${repo}/openspec/changes/${draft.changeId}`
  return (await parallel([
    () => agent(
      `Adversarially critique the change at ${dir} for COMPLETENESS against the intent "${idea}" and this approach:\n${judgment.synthesis}\n` +
      `What outcome, edge case, migration, or rollout step is missing? Missing testing/docs tasks are majors. ` +
      `Return {blockers, majors, minors} as terse strings with file references. Empty arrays if genuinely clean.`,
      { model: 'sonnet', phase: 'Critique', label: 'critic:completeness', schema: CRIT_SCHEMA }),
    () => agent(
      `Adversarially critique the change at ${dir} for FEASIBILITY against the actual codebase in ${repo}. ` +
      `Verify referenced files, APIs, schemas, and utilities exist as described; flag anything the design assumes wrongly, ` +
      `and any conflict with repo guardrails or the constraints docs. Return {blockers, majors, minors}.`,
      { model: 'sonnet', phase: 'Critique', label: 'critic:feasibility', schema: CRIT_SCHEMA }),
    () => agent(
      `Adversarially critique ${dir}/tasks.md for TASK QUALITY: is every subsection independently implementable and reviewable ` +
      `by an agent that sees only that section plus a specRef? Are dependencies between sections explicit? Is any section ` +
      `too big (>~8 checkboxes) or vague? Return {blockers, majors, minors}.`,
      { model: 'sonnet', phase: 'Critique', label: 'critic:tasks', schema: CRIT_SCHEMA }),
  ])).filter(Boolean)
}

let crits = await critique()
let allBlockers = crits.flatMap(c => c.blockers)
let allMajors = crits.flatMap(c => c.majors)

// ── One revise cycle if needed ──────────────────────────────────────────────
let revised = false
if (allBlockers.length + allMajors.length > 0) {
  phase('Revise')
  revised = true
  const fixes = [...allBlockers.map(b => `[blocker] ${b}`), ...allMajors.map(m => `[major] ${m}`)].join('\n- ')
  draft = await agent(
    draftPrompt(`- The artifacts already exist at openspec/changes/${draft.changeId}/ — REVISE them in place to resolve these critique findings, do not rewrite from scratch:\n- ${fixes}\n`),
    { model: 'opus', phase: 'Revise', label: 'revise-artifacts', schema: DRAFT_SCHEMA },
  )
  if (!draft) return { stopped: 'revise-failed' }
  crits = await critique()
  allBlockers = crits.flatMap(c => c.blockers)
  allMajors = crits.flatMap(c => c.majors)
}

return {
  changeId: draft.changeId,
  artifacts: draft.files,
  summary: draft.summary,
  validation: draft.validation || null,
  approach: { winner: judgment.winner, rationale: judgment.rationale },
  critique: {
    revised,
    openBlockers: allBlockers,
    openMajors: allMajors,
    minors: crits.flatMap(c => c.minors),
  },
  next: allBlockers.length
    ? 'Blockers remain after one revise cycle — review them with the user before /hub-plan.'
    : `Review openspec/changes/${draft.changeId}/ then run /hub-plan to reconcile + sync to the hub, then /hub-drain.`,
}
