---
name: git-notes
description: >
  Attach AI observability notes to git commits using refs/notes/agent-log.
  Load this skill when you need to record why a change was made after committing.
---

# Git Notes — Agent Observability

Every task commit must have a Git Note attached to `refs/notes/agent-log`.
This is the AI-blame layer: a permanent record of what was done and why,
stored inside the repo with zero extra files.

## Attach a note (run immediately after git commit)

```bash
git notes --ref=agent-log add -m '{
  "agent":    "opencode",
  "model":    "anthropic/claude-sonnet-4-5",
  "task_id":  "TASK-42",
  "spec_ref": "openspec/specs/living-spec.md",
  "summary":  "One sentence: what was done and why"
}'
```

All fields except `summary` are optional but strongly encouraged.

## Push notes (always include alongside HEAD)

```bash
git push origin HEAD refs/notes/agent-log
```

Notes are NOT pushed by default. Always push them explicitly.

## Read notes

```bash
# Note on latest commit
git notes --ref=agent-log show HEAD

# Note on a specific commit
git notes --ref=agent-log show <hash>

# Browse all annotated commits
git log --show-notes=agent-log --oneline
```

## Amend a note

```bash
git notes --ref=agent-log remove HEAD
git notes --ref=agent-log add -m '{ ...corrected... }'
```

## Schema

| Field | Required | Description |
|-------|----------|-------------|
| `agent` | no | `opencode` or `pi` |
| `model` | no | Model ID used, e.g. `anthropic/claude-sonnet-4-6` |
| `task_id` | no | Hub task ID, e.g. `auth-implement-jwt` |
| `spec_ref` | no | Path to the spec requirement, e.g. `openspec/specs/living-spec.md` |
| `summary` | **yes** | One sentence: what was done and why |

## Guardrails

- Attach a note after **every** task commit — not just major ones
- Always push `refs/notes/agent-log` alongside `HEAD`
- Keep `summary` to one sentence
- Never commit note content as files — it belongs in git's object database only
