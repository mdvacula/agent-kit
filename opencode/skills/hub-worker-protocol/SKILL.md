---
name: hub-worker-protocol
description: The step-by-step protocol every hub-worker tier follows to execute exactly one MCP Task Hub task in a lane worktree — fetch, claim, read narrowly, implement, gates, zero-bloat, commit locally, report the commit range. Loaded by hub-worker, hub-worker-haiku and hub-worker-opus.
---

# hub-worker protocol

You execute exactly ONE task from the MCP Task Hub, end to end, in the repo
path your prompt names (a lane worktree). Follow every step in order.

1. **Fetch**: `task-hub_fetch_tasks(id=<task-id>)`. If it returns `[]`,
   report that and stop.
2. **Claim**: `task-hub_update_task_status(id=<task-id>, status="in-progress")`.
3. **Record base**: in the repo, `git rev-parse HEAD` — remember this SHA;
   your report needs the commit range `<base>..HEAD`.
4. **Read context before writing code**: the repo's `AGENTS.md` and
   `CLAUDE.md`, the task's `metadata.specRef` (a path + anchor into the
   OpenSpec artifacts — read that section), and the neighboring code you'll
   touch. Match existing patterns, naming, and comment density. **Read
   narrowly.** tasks.md and design.md often run 500–1,400 lines; do NOT read
   them whole. Read the specRef section (its `**Spec:**`/`**Design:**` header
   lines name exactly which spec requirements and design decisions apply —
   read those by anchor), the proposal's Why and What Changes, and the
   change's intro/ordering notes. Budget roughly ten read calls before the
   first edit.
5. **Implement** the task minimally and completely. No scope creep: if you
   notice adjacent problems, mention them in your report instead of fixing
   them.
6. **Quality gates**: detect and run the repo's checks (for pnpm repos
   typically `pnpm lint`, `pnpm type-check`, `pnpm test`; otherwise whatever
   AGENTS.md/CLAUDE.md names). All gates must pass before you commit. If a
   gate fails, fix it; if you cannot, go to the Blocked path. If the repo's
   guardrails name a production build as a gate for the area you touched
   (e.g. `next build` for `frontend/` and anything it imports), run it too —
   type-check and unit tests do not exercise bundler module resolution.
   Gates are tests, type-checks, lints, and read-only scripts — **a deploy is
   never a gate**. If a task's checkbox says "run it against real data" or
   "verify in deployment", finish the code half, commit, and take the Blocked
   path naming the run as owner-executed.
7. **Zero-bloat check**: stage your changes, then inspect
   `git diff --cached --name-only`. If it lists any `.jsonl`, `.sqlite`,
   `.db`, lockfiles you didn't intend to change, or task-tracking sidecar
   files — unstage and remove them.
8. **Commit locally**, message referencing the task id (e.g.
   `feat: cluster map markers [p2-2-map-clustering]`). **Never push. Never
   pull. Never rebase or switch branches.** The drain lands the lane after
   review passes.
9. **Tick tracking**: if the task's checkboxes exist in the change's
   `tasks.md` (see `metadata.boxes`), tick them in the same commit or a tiny
   follow-up commit. Leave `OWNER OPS:` / `OWNER DECISION:` boxes unticked.
10. **Complete**: `task-hub_update_task_status(id=<task-id>, status="completed")`.
11. **Report** (this is your return value — raw data, no pleasantries):
    task id, one-paragraph summary, commit range `<base>..<head SHA>`, files
    touched, gate commands run and their results, anything the reviewer
    should scrutinize.

## Fix-cycle mode

If your prompt contains review findings: do NOT re-implement from scratch.
Read the findings, read the existing commits in the given range, and address
each finding with focused follow-up commits. Then re-run gates and report as
above, listing each finding and how you resolved it.

## Blocked path

If the task is ambiguous, contradicts the spec or the code you find, needs a
deploy or a live run, or a gate cannot be made to pass: do NOT guess.
`task-hub_update_task_status(id=<task-id>, status="blocked", notes="<what's wrong + 2-3 options, or the exact commands the owner should run>")`,
then report the blocker and stop. A precise blocker report is a successful
run.

## Hard rules

- One task only — never start another task, even if the queue is visible.
- Never push, pull, rebase, or touch branches; work only in the repo path
  you were given.
- Never modify another project's services, containers, or files outside the
  repo.
- **Never deploy or touch live state.** No `convex deploy`/`convex run`
  against a deployment, `ship.sh`, `docker compose up/restart/build`,
  systemd, env-file edits, or writes to any live database — even to "make it
  actually run" or "verify on real data". Those backends serve real users. A
  task that needs a deploy or a live run ends on the Blocked path with the
  exact commands the owner should run.
- Never commit secrets, .env files, or generated artifacts.
