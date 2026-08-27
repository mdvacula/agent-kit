# agent-kit

Skills, agents, and specs for autonomous coding workflows.

Three tool generations live here side by side — **Claude Code is the current
one**; the OpenCode and pi assets are retained and still work:

| Generation | Where | Status |
|---|---|---|
| **Claude Code** | `claude/` (agents, skills, workflows) | current — see below |
| OpenCode | `agents/opencode/`, `skills/opencode/`, `commands/opencode/`, `.agents/skills/` | retained |
| pi | `commands/pi/`, `skills/pi/` | retained |

## Claude Code generation (current)

Planner/orchestrator = the main session (Fable); workers are tiered subagents
(haiku/sonnet/opus per task), reviews are Opus, and the drain loop is a dynamic
workflow. Review gates BEFORE push (workers never push — the old pull-rebase
races are gone).

```
claude/
├── agents/
│   ├── hub-worker.md           ← canonical worker protocol (sonnet default)
│   ├── hub-worker-haiku.md     ← mechanical-task tier
│   ├── hub-worker-opus.md      ← hard-task tier
│   ├── hub-reviewer.md         ← opus, read-only, VERDICT: PASS|FAIL
│   └── hub-steward.md          ← haiku utility: runLog entries, checkpoint pushes
├── skills/
│   ├── hub-plan/               ← OpenSpec change → reconciliation audit → tiered hub tasks
│   └── hub-status/             ← queue overview, blocked reasons, stale claims
├── workflows/
│   └── hub-drain.js            ← sequential drain: worker → review → fix cycles → push
└── install.sh                  ← manual copy into ~/.claude (no symlinks, no automation)
```

Install: `./claude/install.sh`. Spec authoring always uses the official
OpenSpec (`opsx`) tooling — `npx @fission-ai/openspec@latest update` per repo.
The flow: `/hub-plan` → `/hub-drain {project, change}` → `openspec-verify` →
`/opsx:archive`. Observability is hub-native (`metadata.runLog` per task, plus
the `/ui` viewer) — the old Entire session capture is not used.

## Repo layout

```
agent-kit/
│
├── .agents/skills/             ← auto-discovered by OpenCode + pi (no install needed)
│   ├── agentic-setup/          ← bootstrap a project (dual-mode: local / template)
│   │   ├── SKILL.md
│   │   └── REFERENCE.md
│   └── mcp-hub-setup/          ← set up the MCP Task Hub (dual-mode: local / generate)
│       └── SKILL.md
│
├── agents/
│   └── opencode/               ← OpenCode agent definitions (pi has no agent concept)
│       ├── hub-runner.md
│       ├── hub-orchestrator.md
│       └── openspec-orchestrator.md
│
├── skills/                     ← general-purpose skills installed per-project
│   ├── shared/                 ← works in both OpenCode and pi
│   ├── opencode/               ← OpenCode-specific skills
│   └── pi/                     ← pi-specific skills
│
├── commands/                   ← slash commands / prompt templates installed per-project
│   ├── shared/                 ← same format, works in both tools
│   ├── opencode/               ← OpenCode commands (.opencode/commands/)
│   └── pi/                     ← pi prompt templates (.pi/prompts/) — supports $1/$@ args
│
├── specs/                      ← living specs for kit components
│   ├── agent-kit/spec.md       ← this repo's own spec
│   └── mcp-task-hub/spec.md    ← MCP Task Hub service spec
│
├── tests/
│   └── test_hub_integration.py ← smoke tests against the live hub (stdlib only)
│
├── .opencode/                  ← makes agents/skills live in OpenCode when editing agent-kit
│   └── agents/                 (symlinks → agents/opencode/)
│
└── .github/workflows-disabled/ ← DISABLED pi-agent sync actions (see below)
    ├── sync-template.yml
    └── sync-hub.yml
```

## Three output repos

| Repo | What it is | How to get it |
|------|-----------|---------------|
| `agent-template` | Ready-to-clone project scaffold | `git clone github.com/mdvacula/agent-template my-project` |
| `mcp-task-hub` | Docker service — centralized task state | `git clone github.com/mdvacula/mcp-task-hub ~/mcp-task-hub` |
| `agent-kit` | This repo — source of truth | Edit here; the output repos are edited directly too (sync Actions are disabled) |

## Quick start

### 1. Start the hub (once, outside any project)

```bash
git clone https://github.com/mdvacula/mcp-task-hub ~/infra/task-hub
cd ~/infra/task-hub
cp .env.example .env
docker compose up -d          # binds 127.0.0.1:8050 (compose maps 8050 → container 8000)

# Verify it's healthy
curl http://127.0.0.1:8050/health
# → {"status":"ok","task_count":0}

# Task viewer UI (shadcn/React, read-only)
open http://127.0.0.1:8050/ui/

# Register with Claude Code (user-wide, streamable HTTP)
claude mcp add --scope user --transport http task-hub http://127.0.0.1:8050/mcp
```

### 2. Bootstrap a new project from the template

```bash
git clone https://github.com/mdvacula/agent-template my-project
cd my-project

# Edit the two placeholder files
#   openspec/config.yaml      — fill in PROJECT_NAME, TECH_STACK
#   AGENTS.md                 — replace PROJECT_NAME references

# Wire up git notes fetch refspec (run once per clone)
git config --add remote.origin.fetch '+refs/notes/*:refs/notes/*'
```

### 3. Verify the MCP connection

Open OpenCode in your project and run:

```
fetch_tasks(status="pending")
```

An empty array `[]` confirms the hub is reachable and the MCP tool is wired up.

OpenCode projects should point `opencode.json` at the hub using SSE transport:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "task-hub": {
      "type": "sse",
      "url": "http://localhost:8000/sse",
      "enabled": true,
      "_comment": "Hub runs via Docker. Start with: cd ~/mcp-task-hub && docker compose up -d. Change port if you edited HUB_PORT in .env."
    }
  }
}
```

### 4. Bootstrap an existing project

Instead of cloning the template, invoke the `agentic-setup` skill directly
from inside your project in OpenCode:

```
/skill agentic-setup
```

### 5. Run integration tests (optional)

```bash
# From agent-kit, with hub running
python -m pytest tests/test_hub_integration.py -v
```

## What the harness unlocks

Once a project is bootstrapped with `agentic-setup`, both pi and OpenCode have the full development loop:

```
Idea → spec → tasks in hub → agent picks up tasks → implements → commits → pushes → done
```

### With pi

```bash
# Propose a change: idea → spec artifacts → tasks synced to hub
/opsx-propose

# Execute next pending task end-to-end (auto-picks, no args needed)
/hub-run

# Loop /hub-run until the queue is empty
```

### With OpenCode

```bash
# Propose and plan (same OpenSpec commands)
/opsx-propose

# Run a single task
@hub-runner

# Clear an entire backlog in parallel
@hub-orchestrator
```

### The full loop

```
/opsx-propose           ← agent creates spec + tasks, syncs to hub
/hub-run (or @hub-runner) ← agent claims next task, implements, commits, pushes
/hub-run ...            ← repeat until fetch_tasks(status="pending") returns []
```

Everything is tracked in the hub. Every task commit gets a Git Note on
`refs/notes/agent-log` — a permanent AI-blame record of what was done and why,
stored in the repo itself with zero extra files.

---

## GitHub Actions — DISABLED

The pi-agent sync actions (`sync-hub.yml`, `sync-template.yml`) are parked in
`.github/workflows-disabled/` and do not run. They spawned an unattended coding
agent on every push and regenerated `mcp-task-hub` / `agent-template` from the
specs — but both output repos are now edited directly, so a regeneration would
overwrite real work. If you ever re-enable them, do it deliberately and expect
them to clobber direct edits.

Required secrets on the `agent-kit` repo:

| Secret | Purpose |
|--------|---------|
| `TEMPLATE_REPO_TOKEN` | GitHub PAT with `repo` scope — write access to `agent-template` and `mcp-task-hub` |
| `OPENROUTER_API_KEY` | OpenRouter API key — used by pi (`anthropic/claude-sonnet-4-6`) to run Mode B |

## Toolchain docs

| Tool | Docs |
|------|------|
| MCP | [modelcontextprotocol.io](https://modelcontextprotocol.io/) |
| TaskMD | [driangle.github.io/taskmd](https://driangle.github.io/taskmd/) |
| OpenSpec | [openspec.dev](https://openspec.dev/) |
| OpenCode | [opencode.ai/docs](https://opencode.ai/docs) |
| pi | [github.com/badlogic/pi-mono](https://github.com/badlogic/pi-mono) |
