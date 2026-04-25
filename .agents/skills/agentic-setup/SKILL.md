---
name: agentic-setup
description: >
  Dual-mode startup script for agentic infrastructure targeting OpenCode and pi coding agents.
  LOCAL MODE: bootstraps a real project (runs CLIs, prompts for variables, wires everything up).
  TEMPLATE MODE: runs CLIs in the agent-template working directory, leaves placeholder vars unsubstituted.
  Produces: Git Notes observability, MCP Task Hub config, OpenSpec living spec,
  OpenCode + pi agents/skills/commands, AGENTS.md.
---

# Agentic Infrastructure Setup

This skill operates in two modes. Read the invocation context to determine which applies.

| Mode | Trigger | What it does |
|------|---------|--------------|
| **Local** | Developer clones `agent-kit` and runs this skill in their own project | Executes CLIs, substitutes real variable values, wires up a live project |
| **Template** | pi agent is spawned by `sync-template.yml` to update `agent-template/` | Runs CLIs in the template working directory — leaves `PROJECT_NAME`, `TECH_STACK` etc. as literal placeholders |

---

## Guiding Principle — Zero Bloat

Only code and the Living Spec live in Git.
Task execution state lives in the remote MCP Task Hub.
Agent observability lives in Git Notes — attached to commits, never in the file tree.
No JSONL sidecars, no SQLite files, no task markdown trackers are ever committed.

---

## Target Agents

This skill targets **OpenCode** and **pi**. Do not write any `.cursor/` files.

| Agent | Config root | Observability |
|-------|-------------|---------------|
| **OpenCode** | `.opencode/` | Git Notes on every task commit (`refs/notes/agent-log`) |
| **pi** | `.pi/` | Git Notes on every task commit (`refs/notes/agent-log`) |

---

## Observability — Git Notes

Every task commit gets a Git Note attached to `refs/notes/agent-log`. This is the
"AI blame" layer: a permanent, zero-bloat record of *why* every change was made,
stored inside the repo's own object database — no third-party service required.

### Schema

```json
{
  "agent":     "opencode | pi",
  "model":     "anthropic/claude-sonnet-4-5",
  "task_id":   "task hub ID or local slug",
  "spec_ref":  "openspec change name or living-spec section",
  "summary":   "One sentence: what was done and why"
}
```

All fields except `summary` are optional but strongly encouraged.

### Attaching a note (after every task commit)

```bash
git notes --ref=agent-log add -m '{
  "agent":    "opencode",
  "model":    "anthropic/claude-sonnet-4-5",
  "task_id":  "TASK-42",
  "spec_ref": "auth/jwt-flow",
  "summary":  "Implement JWT refresh flow per living-spec requirement auth/jwt-flow"
}'
```

Agents MUST run this immediately after `git commit`. It is part of the commit
workflow, not an optional extra.

### Reading notes

```bash
# Show note for the latest commit
git notes --ref=agent-log show HEAD

# Show note for any commit
git notes --ref=agent-log show <commit-hash>

# Browse all annotated commits
git log --show-notes=agent-log --oneline
```

### Pushing and fetching notes

Notes are NOT pushed by default. Include them explicitly:

```bash
# Push
git push origin refs/notes/agent-log

# Fetch (first time)
git fetch origin refs/notes/agent-log:refs/notes/agent-log

# Fetch (subsequent — add to .git/config once)
# [remote "origin"]
#   fetch = +refs/notes/*:refs/notes/*
```

Add the fetch refspec to `.git/config` during setup so `git fetch` always
pulls notes automatically (see A3 below).

### Amending a note

```bash
git notes --ref=agent-log remove HEAD
git notes --ref=agent-log add -m '{ ... corrected ... }'
```

---

## Official Docs

| Tool | Docs |
|------|------|
| Git Notes | `man git-notes` · [git-scm.com/docs/git-notes](https://git-scm.com/docs/git-notes) |
| MCP / Task Hub | [modelcontextprotocol.io](https://modelcontextprotocol.io/) · [Python SDK](https://sdk.modelcontextprotocol.io/python/) · [TaskMD schema](https://driangle.github.io/taskmd/) |
| OpenSpec | [openspec.dev](https://openspec.dev/) · [CLI ref](https://thedocs.io/openspec/cli/init/) |
| OpenCode config | [opencode.ai/docs/config](https://opencode.ai/docs/config/) |
| OpenCode agents | [opencode.ai/docs/agents](https://opencode.ai/docs/agents/) |
| OpenCode MCP | [opencode.ai/docs/mcp-servers](https://opencode.ai/docs/mcp-servers/) |

---

---

# MODE A — LOCAL SETUP

_Use this mode when a developer has cloned `agent-kit` and wants to bootstrap a real project._

---

## A0 — Determine Target Directory and Collect Variables

### Locate the agent-kit source

This skill is stored inside `agent-kit`. Resolve `AGENT_KIT_DIR` first:

```bash
# The skill file lives at <agent-kit>/skills/agentic-setup/SKILL.md
# Walk up two directories from this file's location to get AGENT_KIT_DIR.
# Example: if skill is at /home/user/agent-kit/skills/agentic-setup/SKILL.md
#          then AGENT_KIT_DIR=/home/user/agent-kit
```

Agents are in `$AGENT_KIT_DIR/agents/`.

### Determine TARGET_DIR

Apply these rules in order — stop at the first match:

1. **Skill invoked from inside a non-agent-kit project repo** (working directory has its own `package.json`, `go.mod`, `.git`, etc. and is NOT `agent-kit`): use the working directory as `TARGET_DIR`.
2. **Skill invoked from agent-kit itself** or the context says "create a new project / template": ask the user for the path.
3. **User has already provided a path in the invocation message**: use it directly.

When asking, offer a sensible default based on sibling directories visible from `AGENT_KIT_DIR` (e.g., `agent-template` alongside `agent-kit`).

If `TARGET_DIR` does not exist, create it and init git:

```bash
mkdir -p "$TARGET_DIR"
git -C "$TARGET_DIR" init
```

### Collect remaining variables

| Variable | Description | Default / inference |
|----------|-------------|---------------------|
| `PROJECT_NAME` | Short slug for task ID prefixes | Basename of `TARGET_DIR` |
| `TECH_STACK` | Primary stack (for OpenSpec context) | Infer from `package.json`, `go.mod`, `Cargo.toml`, etc. — ask only if none found |

The hub URL is always `http://localhost:8000/sse` (Docker default).

If the user says "run the skill" or "start now", use the best available defaults
and only pause for input if a required value still cannot be inferred.

---

## A1 — Verify CLI

```bash
openspec --version || echo "MISSING: npm install -g @fission-ai/openspec  (or npx @fission-ai/openspec@latest)"
```

Do not proceed until it is present.

---

## A2 — Initialize OpenSpec for OpenCode and pi

Run from `TARGET_DIR`:

```bash
npx @fission-ai/openspec@latest init --tools opencode,pi
```

(If running outside of `TARGET_DIR`, use `--cwd "$TARGET_DIR"` or `cd` first.)

This generates:
- `.opencode/commands/opsx-*.md` — OpenSpec slash commands for OpenCode
- `.opencode/skills/openspec-*/SKILL.md` — OpenSpec skills for OpenCode
- `.pi/prompts/opsx-*.md` — OpenSpec slash commands for pi
- `.pi/skills/openspec-*/SKILL.md` — OpenSpec skills for pi

Then write `$TARGET_DIR/openspec/config.yaml` (overwrite whatever init created),
substituting real values for `PROJECT_NAME` and `TECH_STACK`:

```yaml
schema: spec-driven

context: |
  Project: PROJECT_NAME
  Tech stack: TECH_STACK
  Task hub: http://localhost:8000/sse (Docker — cd ~/mcp-task-hub && docker compose up -d)
  Zero-bloat rule: task state in hub, observability in git notes (refs/notes/agent-log).
```

Create the Living Spec:

```bash
mkdir -p "$TARGET_DIR/openspec/specs"
```

Write `$TARGET_DIR/openspec/specs/living-spec.md`:

```markdown
# Living Spec — PROJECT_NAME

> Source of truth for requirements. Agents parse this file to sync tasks
> to the MCP Task Hub. Mark requirements complete here as work lands.
> This file IS tracked in Git.

## Capabilities

<!-- Add capability sections below.
     Each unchecked item becomes a pending task in the hub. -->

### Example

- [ ] Implement X
- [ ] Test X
- [ ] Document X
```

---

## A3 — Configure Git Notes Fetch Refspec

Only run this step if the repo already has a remote named `origin`:

```bash
# Check for a remote first
if git -C "$TARGET_DIR" remote get-url origin &>/dev/null; then
  git -C "$TARGET_DIR" config --add remote.origin.fetch '+refs/notes/*:refs/notes/*'
  git -C "$TARGET_DIR" config --get-all remote.origin.fetch
  echo "✓ Notes fetch refspec configured"
else
  echo "No remote yet — skipping. Run after git remote add origin <url>:"
  echo "  git config --add remote.origin.fetch '+refs/notes/*:refs/notes/*'"
fi
```

This is a local `.git/config` change — it is not committed.

The A8 verification step and A9 push step are also conditioned on remote presence
(see below) — no need to block here.

---

## A4 — Start the MCP Task Hub

The hub runs as a Docker container. One instance serves all projects — start it
once and leave it running.

**Always try this first:**

```bash
if [ -d ~/mcp-task-hub ]; then
  docker compose -f ~/mcp-task-hub/docker-compose.yml up -d
  sleep 2
  curl -sf http://localhost:8000/health && echo "✓ Hub running" || echo "⚠ Hub failed to start"
else
  echo "Hub not installed — see skills/mcp-hub-setup/SKILL.md (Mode A)"
fi
```

If the hub directory does not exist, stop and tell the user to run
`skills/mcp-hub-setup/SKILL.md` (Mode A) first, then return here.

**Write `opencode.json` for this project** (create or merge into existing):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "task-hub": {
      "type": "remote",
      "url": "http://localhost:8000/sse",
      "enabled": true
    }
  }
}
```

If your hub runs on a different port (set in `~/mcp-task-hub/.env`), update
the URL to match.

**Verify:** Start OpenCode and call `fetch_tasks(status="pending")` — an empty list is a successful response.

> **Note:** pi uses MCP tools made available through the agent runner environment.
> Document the hub URL in `AGENTS.md` so pi agents can reference it.

---

## A5 — Install Agents, Skills, and Commands

First, ask which tools the project uses: **OpenCode**, **pi**, or **both**.
Only install what's relevant.

**Skills are automatic** — both tools scan `.agents/skills/` walking up from the
project root. No copying needed if the project lives inside or alongside `agent-kit`.
If it does NOT, copy the whole `.agents/` directory:

```bash
cp -r "$AGENT_KIT_DIR/.agents" "$TARGET_DIR/.agents"
```

**Agents** (OpenCode only — pi has no agent concept):

```bash
AK="$AGENT_KIT_DIR"
T="$TARGET_DIR"

mkdir -p "$T/.opencode/agents"
cp "$AK/agents/opencode/hub-runner.md"            "$T/.opencode/agents/hub-runner.md"
cp "$AK/agents/opencode/hub-orchestrator.md"      "$T/.opencode/agents/hub-orchestrator.md"
cp "$AK/agents/opencode/openspec-orchestrator.md" "$T/.opencode/agents/openspec-orchestrator.md"
```

**Skills** (tool-specific, from `skills/`):

```bash
# Shared skills — copy to both
cp -r "$AK/skills/shared/." "$T/.agents/skills/"       2>/dev/null || true

# OpenCode-specific skills
cp -r "$AK/skills/opencode/." "$T/.opencode/skills/"   2>/dev/null || true

# pi-specific skills
cp -r "$AK/skills/pi/." "$T/.agents/skills/"           2>/dev/null || true
```

**Commands / prompt templates** (tool-specific, from `commands/`):

```bash
# Shared commands — work in both tools unchanged
mkdir -p "$T/.opencode/commands" "$T/.pi/prompts"
cp "$AK/commands/shared/"*.md "$T/.opencode/commands/" 2>/dev/null || true
cp "$AK/commands/shared/"*.md "$T/.pi/prompts/"        2>/dev/null || true

# OpenCode-specific commands
cp "$AK/commands/opencode/"*.md "$T/.opencode/commands/" 2>/dev/null || true

# pi-specific prompt templates (support $1/$@ argument syntax)
cp "$AK/commands/pi/"*.md "$T/.pi/prompts/" 2>/dev/null || true
```

---

## A6 — Write AGENTS.md

Write `AGENTS.md` at repo root. Substitute `PROJECT_NAME` throughout.

```markdown
# Agent Workflow — PROJECT_NAME

This repo uses **Git Notes** (agent observability), **MCP Task Hub** (centralized
task state), **OpenSpec** (living specs), **OpenCode** and **pi** (agents, skills, commands).

## Zero-Bloat Rule

Only code and the Living Spec live in Git's file tree.
Task state lives in the remote MCP Task Hub.
Agent observability lives in `refs/notes/agent-log` — never in committed files.
Never commit JSONL, SQLite, or task markdown sidecars.

## Toolchain

| Tool | Role | Notes |
|------|------|-------|
| **Git Notes** | Agent observability | `refs/notes/agent-log` — attached to every task commit |
| **MCP Task Hub** | Task execution state | `sync_task` · `fetch_tasks` · `update_task_status` · `http://localhost:8000/sse` |
| **OpenSpec** | Living Spec + change workflow | `openspec/specs/living-spec.md` is source of truth |
| **OpenCode** | Primary coding agent | `.opencode/` — agents, skills, commands |
| **pi** | Orchestration / CI agent | `.pi/` — agents, skills, prompts |

## Git Notes Quick Reference

```bash
# Attach a note after committing (REQUIRED after every task commit)
git notes --ref=agent-log add -m '{"agent":"opencode","task_id":"TASK-42","summary":"..."}'

# Read the note on the latest commit
git notes --ref=agent-log show HEAD

# Browse all annotated commits
git log --show-notes=agent-log --oneline

# Push notes to remote
git push origin refs/notes/agent-log

# Ensure notes are fetched automatically
git config --add remote.origin.fetch '+refs/notes/*:refs/notes/*'
```

## MCP Quick Reference

| Tool | Usage |
|------|-------|
| `fetch_tasks(status="pending")` | Get work queue |
| `fetch_tasks(id="<id>")` | Get single task |
| `update_task_status(id, "in-progress")` | Claim a task |
| `update_task_status(id, "completed")` | Close a task |
| `sync_task(id, title, status, metadata)` | Upsert task + metadata |

## Session Start

1. `fetch_tasks(status="pending")` — health check and queue
2. Parse `openspec/specs/living-spec.md` → `sync_task` for any new requirements
3. Pick top pending task

## Task Execution Loop

1. `update_task_status(id, "in-progress")`
2. Implement
3. `git commit -m "..."`
4. `git notes --ref=agent-log add -m '{"agent":"...","task_id":"...","summary":"..."}'`
5. Tests pass, build green
6. `update_task_status(id, "completed")`
7. Mark requirement done in `openspec/specs/living-spec.md`
8. `git push origin HEAD refs/notes/agent-log`

## Landing the Plane

```bash
# Zero-bloat check before every push
git diff --cached --name-only
# Remove anything ending in .jsonl .sqlite .db or task markdown sidecars

git pull --rebase
git push origin HEAD refs/notes/agent-log
git status   # MUST show "up to date with origin"
```

## Forbidden Patterns

- Committing `.jsonl`, `.sqlite`, `.db`, or task markdown sidecars
- Closing a task before the build passes
- Closing a task with uncommitted changes
- Pushing without also pushing `refs/notes/agent-log`
- Stopping before `git push` succeeds

## Agents

| Agent | Purpose |
|-------|---------|
| `hub-runner` | Execute one task end-to-end |
| `hub-orchestrator` | Coordinate parallel hub-runner subagents |
| `openspec-orchestrator` | Plan: idea → spec → tasks synced to hub |
```

---

## A7 — Update .gitignore

Append to the root `.gitignore` (create if absent):

```gitignore
# OpenSpec change working artifacts
openspec/changes/
openspec/changes/*/proposal.md
openspec/changes/*/design.md
openspec/changes/*/tasks.md
openspec/changes/*/beads-commands.md
openspec/changes/*/research.md

# Zero-bloat — task artifacts never in Git
*.tasks.jsonl
*.tasks.md
tasks.db
tasks.sqlite
.tasks/
.beads/
```

`openspec/specs/` is NOT ignored — it is the Living Spec.

---

## A8 — Verify

Run all checks against `TARGET_DIR`:

```bash
T="$TARGET_DIR"

openspec --version && echo "✓ OpenSpec"

# Hub reachable
curl -sf http://localhost:8000/health && echo "✓ Hub" || echo "⚠ Hub not responding — run: cd ~/mcp-task-hub && docker compose up -d"

# Git notes refspec (only meaningful if a remote exists)
if git -C "$T" remote get-url origin &>/dev/null; then
  git -C "$T" config --get-all remote.origin.fetch | grep notes \
    && echo "✓ Notes fetch refspec" \
    || echo "⚠ Run: git -C $T config --add remote.origin.fetch '+refs/notes/*:refs/notes/*'"
else
  echo "ℹ No remote yet — notes refspec will be added after 'git remote add origin'"
fi

# OpenSpec commands
ls "$T/.opencode/commands/" "$T/.pi/prompts/" 2>/dev/null && echo "✓ OpenSpec commands"

# Agents
ls "$T/.opencode/agents/" "$T/.pi/agents/" && echo "✓ Agent files"

# Skills — auto-discovered from .agents/skills/ (no per-project copy needed)
ls "$AGENT_KIT_DIR/.agents/skills/" && echo "✓ Skills available via .agents/skills/ walk-up"

# Core docs
ls "$T/AGENTS.md" "$T/openspec/specs/living-spec.md" "$T/opencode.json" && echo "✓ Core docs"

# Zero-bloat
ls "$T/.beads/" 2>/dev/null && echo "⚠ WARNING: .beads present" || echo "✓ No .beads"
ls "$T/tasks.db" 2>/dev/null && echo "⚠ WARNING: tasks.db present" || echo "✓ No task DB"
```

---

## A9 — Initial Commit

```bash
T="$TARGET_DIR"

git -C "$T" add \
  AGENTS.md \
  .gitignore \
  opencode.json \
  .opencode/ \
  .pi/ \
  openspec/config.yaml \
  openspec/specs/

git -C "$T" commit -m "chore: bootstrap agentic infrastructure

- Git Notes observability (refs/notes/agent-log)
- MCP Task Hub config in opencode.json
- OpenSpec living spec scaffold (opencode + pi)
- Agents: hub-runner, hub-orchestrator, openspec-orchestrator
- AGENTS.md workflow reference
- Zero-bloat gitignore rules"

# Attach the bootstrap note
git -C "$T" notes --ref=agent-log add -m '{
  "agent":   "agentic-setup",
  "summary": "Bootstrap commit — agentic infrastructure wired up"
}'

# Push only if a remote exists
if git -C "$T" remote get-url origin &>/dev/null; then
  git -C "$T" push origin HEAD refs/notes/agent-log
else
  echo "ℹ No remote configured — skipping push."
  echo "  When ready: git remote add origin <url>"
  echo "              git config --add remote.origin.fetch '+refs/notes/*:refs/notes/*'"
  echo "              git push -u origin HEAD refs/notes/agent-log"
fi
```

---

---

# MODE B — TEMPLATE GENERATION

_Use this mode when the pi agent is spawned by `sync-template.yml` to update `agent-template/`._

**Rules for this mode:**
- Run CLIs as normal — they are non-interactive via flags
- Do NOT substitute `PROJECT_NAME`, `TECH_STACK`, etc. — leave them as literal placeholder strings
- Write files into the working directory (which is a checkout of `agent-template/`)
- Source files come from the `agent-kit/` checkout made available by the Action
- After running CLIs, overwrite `openspec/config.yaml` and `openspec/specs/living-spec.md`
  with the template placeholder versions (so they don't contain real project data)
- Commit message format: `chore(template): sync from agent-kit <short-sha>`

---

## B1 — Run CLIs

### OpenSpec

```bash
npx @fission-ai/openspec@latest init --tools opencode,pi
```

Generates `.opencode/commands/`, `.opencode/skills/`, `.pi/prompts/`, `.pi/skills/`.

---

## B2 — Write Static Scaffold Files

After the CLI runs, write these files (overwriting anything the CLI may have created):

### `AGENTS.md`

Write the template version — identical to Mode A Step A6 but with literal
placeholder strings (`PROJECT_NAME`) left unsubstituted.

### `.gitignore`

Write the full contents from Mode A Step A7. This is the same every time.

### `opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "task-hub": {
      "type": "remote",
      "url": "http://localhost:8000/sse",
      "enabled": true,
      "_comment": "Hub runs via Docker. Start with: cd ~/mcp-task-hub && docker compose up -d. Change port if you edited HUB_PORT in .env."
    }
  }
}
```

### `openspec/config.yaml`

```yaml
schema: spec-driven

context: |
  Project: PROJECT_NAME
  Tech stack: TECH_STACK
  Task hub: http://localhost:8000/sse (Docker — cd ~/mcp-task-hub && docker compose up -d)
  Zero-bloat rule: task state in hub, observability in git notes (refs/notes/agent-log).

# Uncomment and fill in after cloning:
# rules:
#   proposal:
#     - Keep proposals under 500 words
#   tasks:
#     - Break tasks into chunks under 2 hours
```

### `openspec/specs/living-spec.md`

```markdown
# Living Spec — PROJECT_NAME

> Source of truth for requirements. Agents parse this file to sync tasks
> to the MCP Task Hub. Mark requirements complete here as work lands.
> This file IS tracked in Git.

## Capabilities

<!-- Add capability sections below.
     Each unchecked item becomes a pending task in the hub. -->

### Example

- [ ] Implement X
- [ ] Test X
- [ ] Document X
```

### `README.md`

```markdown
# agent-template

Ready-to-clone scaffold for agentic projects using **OpenCode** and **pi**.

## Quick Start

1. Clone this repo into your new project directory
2. Open `opencode.json` and update the MCP Task Hub URL if your hub runs on a non-default port
3. Configure git notes fetch refspec: `git config --add remote.origin.fetch '+refs/notes/*:refs/notes/*'`
4. Run `npx @fission-ai/openspec@latest init --tools opencode,pi` to refresh OpenSpec files
5. Edit `openspec/specs/living-spec.md` with your project's requirements
6. Edit `openspec/config.yaml` — fill in `PROJECT_NAME`, `TECH_STACK`
7. Edit `AGENTS.md` — replace `PROJECT_NAME` references

## What's Included

| Path | Purpose |
|------|---------|
| `AGENTS.md` | Workflow reference for all agents |
| `opencode.json` | OpenCode config — MCP Task Hub endpoint |
| `.opencode/agents/` | hub-runner, hub-orchestrator, openspec-orchestrator |
| `.opencode/skills/` | OpenSpec skills + agentic-setup skill |
| `.opencode/commands/` | OpenSpec slash commands (`/opsx-*`) |
| `.pi/agents/` | hub-runner, hub-orchestrator, openspec-orchestrator |
| `.pi/skills/` | OpenSpec skills + agentic-setup skill |
| `.pi/prompts/` | OpenSpec slash commands (`/opsx-*`) |
| `openspec/specs/living-spec.md` | Living Spec starter |
| `openspec/config.yaml` | OpenSpec schema + context |

## Observability

Every task commit gets a Git Note on `refs/notes/agent-log`:

```bash
git notes --ref=agent-log add -m '{"agent":"opencode","task_id":"...","summary":"..."}'
git push origin HEAD refs/notes/agent-log
git log --show-notes=agent-log --oneline
```

No third-party service. No extra files. The "AI blame" lives inside your own repo.

## Source

Generated from [agent-kit](https://github.com/mdvacula/agent-kit) by the agentic-setup skill.
```

---

## B3 — Copy Source Files

Copy the `.agents/` directory so the template carries skill discovery with it:

```
agent-kit/.agents/  →  .agents/
```

OpenCode agents (pi has no agent concept):

```
agent-kit/agents/opencode/hub-runner.md            → .opencode/agents/hub-runner.md
agent-kit/agents/opencode/hub-orchestrator.md      → .opencode/agents/hub-orchestrator.md
agent-kit/agents/opencode/openspec-orchestrator.md → .opencode/agents/openspec-orchestrator.md
```

Commands and prompt templates:

```
agent-kit/commands/shared/*.md   → .opencode/commands/  AND  .pi/prompts/
agent-kit/commands/opencode/*.md → .opencode/commands/
agent-kit/commands/pi/*.md       → .pi/prompts/
```

Skills (from `skills/`):

```
agent-kit/skills/shared/*   → .agents/skills/     (both tools)
agent-kit/skills/opencode/* → .opencode/skills/
agent-kit/skills/pi/*       → .agents/skills/     (pi discovers via .agents/skills/)
```

---

## B4 — Verify File Tree

Confirm the following exist before committing:

```
AGENTS.md
README.md
.gitignore
opencode.json
.agents/skills/agentic-setup/SKILL.md
.agents/skills/agentic-setup/REFERENCE.md
.agents/skills/mcp-hub-setup/SKILL.md
.opencode/agents/hub-runner.md
.opencode/agents/hub-orchestrator.md
.opencode/agents/openspec-orchestrator.md
.opencode/commands/opsx-propose.md
.pi/prompts/opsx-propose.md
openspec/config.yaml
openspec/specs/living-spec.md
```

If any are missing, write them before proceeding.

---

## B5 — Commit

```bash
git add .
git commit -m "chore(template): sync from agent-kit <short-sha>

Updated files:
$(git diff --cached --name-only)"
```

Then open a pull request against `agent-template/main`.
The PR description should list which source files changed and link to the
triggering commit in `agent-kit`.
