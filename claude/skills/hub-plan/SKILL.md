---
name: hub-plan
description: Plan an OpenSpec change and sync it to the MCP Task Hub as tiered, chunked tasks. Use when the user wants to plan/queue work for the agent drain loop ("hub-plan", "sync tasks to the hub", "queue up this change"). Spec artifacts always come from the official OpenSpec (opsx) tooling — this skill layers reconciliation, chunking, tiering, and hub sync on top.
---

# hub-plan — plan a change and sync it to the Task Hub

You (the main session) are the planner. You never implement here. The output is
a reconciled OpenSpec change plus a queue of well-scoped tasks in the hub,
ready for `/hub-drain`.

The full agentic loop this sits in:
`/hub-spec {project, idea}` (workflow: explore → approaches → draft → critique)
→ **human reviews the artifacts** → `/hub-plan` (this skill: reconcile → chunk
→ tier → sync) → `/hub-drain` (workflow: implement → review → push) →
`openspec-verify-change` + `/opsx:archive`.

## 1. Establish scope

- `project` = the repo's directory name (e.g. `newjerseybrews`).
- Target change: an existing `openspec/changes/<id>/` or a new one.
- For a NEW change: prefer the `/hub-spec` workflow (it explores the codebase,
  judges competing approaches, drafts artifacts per the repo's OpenSpec schema,
  and adversarially critiques them). For small/obvious changes the repo's
  `openspec-propose` / `/opsx:propose|ff` tooling directly is fine
  (`npx @fission-ai/openspec@latest update` if the repo lacks it). Never
  hand-write proposal/design/tasks files outside these paths.
- If `/hub-spec` just ran, read its returned critique — open blockers must be
  resolved with the user before syncing anything.

## 2. Reconciliation audit — MANDATORY, before any sync

tasks.md files rot. For each item in the change's `tasks.md`, check it against
the actual codebase and any superseding docs (roadmaps, source-policy docs,
newer changes). Classify every item:

- **done** — already implemented: tick the checkbox with a `(reconciled <date>)`
  note. Do not sync.
- **obsolete** — superseded or now forbidden (e.g. an API that no longer
  exists, a policy that bans the approach): strike it through with a one-line
  reason. Do not sync.
- **todo** — genuinely remaining work. This is what gets synced.

Present the audit summary (counts + notable obsoletes) to the user BEFORE
syncing. This step regularly rewrites half the plan — do not skip it.

## 3. Chunk into hub tasks

- One hub task per coherent subsection / 3–8 related checkboxes. NEVER one hub
  task per checkbox. Target 8–20 hub tasks per change.
- Each task must be independently implementable and reviewable: a worker gets
  only the task + specRef, so the title and spec section must carry the intent.
- Model dependencies with `blockedBy`/`blocks` (task IDs), not ordering hopes.

### Plan for parallel lanes (added 2026-09-03)

`/hub-drain` runs several lanes at once, each in its own git worktree. A lane
takes the next runnable task whose files do not collide with what other lanes
are working on. The plan decides how much of that width is usable:

- **`blockedBy` is a data dependency, nothing else.** Add an edge only when a
  task reads code, schema, or an artifact that another task writes. "Safer to
  do after", "same subsystem", "review them together" are NOT edges — they
  serialize a lane for no reason. If the spec's ordering notes say two groups
  "must land together", ask whether that is true at the file level; usually
  one direction of dependency is real and the other is habit.
- **Declare `touches`** on every task: the top-level paths it will edit, as
  path prefixes (`["worker/src/workflows/rssIngest.ts", "convex/schema.ts",
  "frontend/src/components/coverage/"]`). The drain uses it as the collision
  lock: two tasks with disjoint `touches` may run concurrently even inside
  one change; a task without `touches` falls back to a change-wide lock.
  Derive it from the spec section's **Files:** line and the design; be
  generous with prefixes rather than precise and wrong.
- **Chunk for width.** With N lanes, a change whose tasks form one long chain
  keeps one lane busy and N−1 idle. Aim for at least N independent roots per
  change (tasks with no `blockedBy`), and keep each blocker chain short.
  Merge sequential steps that share files into one task; split steps that
  touch disjoint files into separate tasks even when they are small.
- **Owner-gated work is its own task.** Any box that needs a deploy, a run
  against a live backend or database, a hands-on check, or a sign-off becomes
  a separate task titled `OWNER OPS:` or `OWNER DECISION:` with status
  `blocked`, the exact commands or the proposed default in `notes`, blocking
  only what truly depends on it. Never fold such a box into an agent task —
  workers may not deploy or touch live state and will stop on it.
- **External gates** (a box that waits on another change) also sync as
  `blocked` with the gate named in `notes`, never as runnable `pending`.

## 4. Assign priority and tier

Priority: P0 = setup/scaffolding others depend on; P1 = core features AND
tests/docs (quality is not optional); P2 = polish, deploy chores.

Tier (`metadata.tier`) rubric:
- **haiku** — mechanical, fully specified, ≤2 files, no new tests: renames,
  config values, copy changes, ticking docs.
- **sonnet** — the default: features, tests, multi-file changes following
  existing patterns.
- **opus** — schema/migrations, algorithmic or fuzzy logic, auth/security,
  concurrency, or anything still ambiguous after the audit.

## 5. Sync

For each todo task:

```
mcp__task-hub__sync_task(
  id="<change-id>-<task-slug>",         # stable, kebab-case
  title="<imperative summary>",
  status="pending",
  project="<repo dir name>",
  metadata={
    change: "<change-id>",
    specRef: "openspec/changes/<id>/design.md#<section>",  # or specs/ path
    priority: "P0|P1|P2", type: "task|feature|chore",
    tier: "haiku|sonnet|opus",
    blockedBy: [...], blocks: [...],
    touches: ["<path prefix>", ...],   # collision lock for parallel lanes
    boxes: "3.1-3.6",                  # which tasks.md checkboxes this covers
    notes: "...",                      # owner commands / proposed default / gate
  })
```

Never write task-tracking sidecar files into the repo — the hub is the state
store; `tasks.md` holds only the reconciled checkboxes.

If this session lacks the `mcp__task-hub__*` tools (started before the server
was registered, or MCP never attached to this lineage), fall back in order:
1. Delegate to a `hub-steward` agent — "Job D" — with the project name and the
   full task list as JSON (works only if the lineage has the MCP tools).
2. `~/.claude/scripts/hub-cli.py` — a plain-HTTP MCP client for the hub:
   `echo '<tasks JSON array>' | python3 ~/.claude/scripts/hub-cli.py sync-batch --project <p>`
   (also `sync`, `fetch`, `set-status`, `status`). Same write path and
   validation as MCP; never hand-roll curl JSON-RPC. For big changes you can also
fan the §2 audit out: one Explore agent per tasks.md section, each classifying
its items against the codebase, then merge.

## 6. Report

Counts by priority/tier, the dependency roots (tasks runnable immediately), and
the suggested next step: `/hub-drain` with `{project, change, maxTasks: 3}` for
a babysat first batch. After a drain finishes the change, close the loop with
the official tooling: `openspec-verify-change`, then archive via `/opsx:archive`.
