---
description: Pick the next pending task from the MCP Task Hub and execute it end-to-end
---

Pick the next pending task from the MCP Task Hub and execute it completely:
claim → read context → implement → quality gates → commit → git note → mark complete → push.

---

## Step 1 — Get next pending task

```
fetch_tasks(status="pending")
```

Tasks are returned ordered by priority (P0 first) then creation time. Take the **first result**.

If the list is empty: report "No pending tasks in the hub." and stop.

---

## Step 2 — Claim it

```
update_task_status(id="<task-id>", status="in-progress")
```

If this fails (already claimed or missing): report the error and stop.

Print:
```
## Running Task: <id>
Title: <title>
```

---

## Step 3 — Read context

- Read `AGENTS.md` for project conventions and forbidden patterns
- If the task's `metadata.specRef` is set, read that section of `openspec/specs/living-spec.md`
- Scan neighboring code for patterns and conventions

---

## Step 4 — Implement

Make the changes required by the task. Keep changes minimal and focused.

**If the task is blocked or unclear:**
- Describe the issue and your options
- Call `update_task_status(id="<task-id>", status="blocked")`
- Stop and wait for guidance — do NOT guess at requirements

---

## Step 5 — Quality gates

Run whatever quality checks the project has configured:

```bash
# Run whichever of these exist
npm test 2>/dev/null || true
npm run lint 2>/dev/null || true
npm run typecheck 2>/dev/null || true
python -m pytest 2>/dev/null || true
```

If tests fail due to your changes, fix them before proceeding. If they were already failing, note it and continue.

---

## Step 6 — Zero-bloat check and commit

```bash
git diff --cached --name-only
```

If the diff contains any `.jsonl`, `.sqlite`, `.db`, or task markdown sidecars — remove them. Only code and Living Spec changes belong in the commit.

```bash
git add .
git commit -m "<verb>: <what was done> (<task-id>)"
```

---

## Step 7 — Attach Git Note

Run immediately after the commit — this is required, not optional:

```bash
git notes --ref=agent-log add -m "{
  \"agent\": \"pi\",
  \"task_id\": \"<task-id>\",
  \"summary\": \"<one sentence: what was done and why>\"
}"
```

---

## Step 8 — Mark complete on hub

```
update_task_status(id="<task-id>", status="completed")
```

---

## Step 9 — Update the Living Spec

Find the requirement in `openspec/specs/living-spec.md` that corresponds to this task (use `metadata.specRef` if present). Mark it done — tick the checkbox or update the status.

```bash
git add openspec/specs/living-spec.md
git commit -m "docs: mark <task-id> complete in living spec" 2>/dev/null || true
# (skip if no changes)
```

---

## Step 10 — Push

```bash
git pull --rebase
git push origin HEAD refs/notes/agent-log
```

If push fails, resolve conflicts and retry until it succeeds.

Verify:
```bash
git status
# Must show: "Your branch is up to date with 'origin/..."
```

---

## Step 11 — Report

```
## Task Complete: <id>

**Title:** <title>
**Commit:** <git log -1 --format='%h'>
**Pushed:** ✓

<brief summary of what was implemented>
```

---

## Guardrails

- Execute exactly ONE task — the first pending one returned by the hub
- NEVER stop before pushing to remote
- NEVER commit `.jsonl`, `.sqlite`, `.db`, or task markdown sidecars
- If blocked, set status to `blocked` and explain — don't guess
- Follow `AGENTS.md` conventions at all times
- Git Note after every task commit is **required**
- `refs/notes/agent-log` must be pushed alongside `HEAD`

## Done means done

Work is not complete until ALL of these are true:

1. ✓ Task fetched and claimed (`in-progress`)
2. ✓ Changes implemented
3. ✓ Quality gates passed (or pre-existing failures noted)
4. ✓ Commit made (no task artifacts in diff)
5. ✓ Git Note attached (`refs/notes/agent-log`)
6. ✓ Task marked `completed` on hub
7. ✓ Living Spec requirement ticked
8. ✓ `git push origin HEAD refs/notes/agent-log` succeeded
9. ✓ `git status` shows up to date
