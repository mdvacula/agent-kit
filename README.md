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
│   ├── hub-plan/               ← reconciliation audit → chunk → tier → sync to hub
│   └── hub-status/             ← queue overview, blocked reasons, stale claims
├── workflows/
│   ├── hub-spec.js             ← agentic spec dev: explore ∥ → 3 approaches → judge → draft → critique → revise
│   └── hub-drain.js            ← sequential drain: worker → review → fix cycles → push
└── install.sh                  ← manual copy into ~/.claude (no symlinks, no automation)
```

Install: `./claude/install.sh`. Spec artifacts always follow the official
OpenSpec (`opsx`) conventions — `npx @fission-ai/openspec@latest update` per
repo; `/hub-spec` drafts through them agentically.

The end-to-end loop (one human gate, marked ★):

```
/hub-spec {project, idea}    ← workflow: explore ∥ → competing approaches → judge
                                → draft artifacts → adversarial critique → revise
★ review openspec/changes/<id>/  (the only mandatory human step)
/hub-plan                    ← reconcile tasks.md vs reality → chunk → tier → sync
/hub-drain {project, change} ← workflow: tiered worker → opus review → fix cycles → push
openspec-verify + /opsx:archive
```

Escalations are the second, conditional human touchpoint: `/hub-drain` returns
early on any blocker (worker blocked, gates unfixable, review failed twice) and
the main session presents retry/skip/abort options. Observability is hub-native
(`metadata.runLog` per task, plus the `/ui` viewer) — the old Entire session
capture is not used.

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

## Using the Claude Code workflow

### One-time setup

```bash
# 1. Hub (state store + UI) — once per machine
git clone https://github.com/mdvacula/mcp-task-hub ~/infra/task-hub
cd ~/infra/task-hub && cp .env.example .env && docker compose up -d
curl http://127.0.0.1:8050/health        # → {"status":"ok","task_count":0}

# 2. Register the hub with Claude Code (user-wide)
claude mcp add --scope user --transport http task-hub http://127.0.0.1:8050/mcp

# 3. Install the agents / skills / workflows
git clone https://github.com/mdvacula/agent-kit && ./agent-kit/claude/install.sh
```

Then **open a new Claude Code session** — sessions started before step 2 can't
see the hub tools, and that silently breaks every stage below.

### Onboard a repo (once per project)

```bash
cd ~/code/<project>
npx -y @fission-ai/openspec@latest init --tools claude   # /opsx commands + openspec-* skills
```

Also add the repo's gate commands (`pnpm lint`, `pnpm type-check`, `pnpm test`,
git basics) to `.claude/settings.json` permissions — workflow subagents inherit
that allowlist, and anything not on it stalls a drain run on a permission
prompt.

### The loop, stage by stage

**1. `/hub-spec` — turn an idea into reviewed spec artifacts** *(workflow, ~12 agents)*

```
/hub-spec {project: "newjerseybrews", idea: "trip planner should support multi-day routes"}
```

Three parallel explorers map the relevant code, the repo's OpenSpec
conventions, and the constraint docs (ADRs, policies — the stuff that makes
naive plans wrong). Three designers draft competing approaches through
different lenses (minimal / robust / leverage-existing); an Opus judge picks a
winner and grafts in the losers' best ideas. An Opus author then writes
`openspec/changes/<id>/{proposal,design,tasks}.md` following the repo's own
schema, and three adversarial critics attack it (completeness, feasibility
against the actual codebase, task quality). One revise cycle if they find real
problems. Nothing is committed or synced.

**2. ★ Review the artifacts** — *the one mandatory human step.* Read
`openspec/changes/<id>/`, edit anything you disagree with, resolve any critique
blockers the workflow reported. Cheap here, expensive later.

**3. `/hub-plan` — reconcile and queue** *(skill, main session)*

Audits every `tasks.md` item against the codebase first (done / obsolete /
todo — stale plans get corrected, not executed), then chunks the real work into
8–20 hub tasks (3–8 checkboxes each), assigns priority (P0–P2) and a model tier
per task, wires `blockedBy` dependencies, and syncs to the hub with
`project` set. You see the audit before anything is synced.

**4. `/hub-drain` — execute** *(workflow, sequential)*

```
/hub-drain {project: "newjerseybrews", change: "<id>", maxTasks: 3}   # babysat first batch
/hub-drain {project: "newjerseybrews", change: "<id>"}                # then the rest
```

Per task: a worker at the task's tier claims it, reads the specRef + repo
guardrails, implements, runs the gates, commits locally (**workers never
push**). An Opus reviewer inspects the commit range against the spec and
re-runs gates; on FAIL the findings go to a fresh worker for a fix cycle (max
2, second one bumps the tier). After PASS, a steward records the `runLog` and
pushes at checkpoints (every ~3 tasks). Watch live via `/workflows` or the hub
UI.

**5. Close the change**: `openspec-verify-change` to validate implementation
against the artifacts, then `/opsx:archive`.

### When something blocks

`/hub-drain` never pushes through a failure — it marks the task `blocked`
(with a required reason, visible in the UI and `/hub-status`) and **returns
early**; the main session then offers retry / skip / abort / investigate.
Relaunching the drain is idempotent: completed tasks aren't refetched.
`/hub-status` also flags stale claims (`in-progress` >2 h — usually a dead
run; reset to `pending` after confirming).

### Model tiers

| Tier | Worker | Gets |
|---|---|---|
| `haiku` | hub-worker-haiku | mechanical, fully-specified, ≤2 files, no new tests |
| `sonnet` | hub-worker | the default: features, tests, pattern-following multi-file work |
| `opus` | hub-worker-opus | schema/migrations, algorithmic logic, auth/security, concurrency, ambiguity |

Reviews are always Opus. Escalation only bumps tiers up, never down. The
planner assigns `metadata.tier`; override it in the hub when you disagree.

---

## Legacy: OpenCode & pi generations

Retained but not the current path, and **partially stale**: the v2 hub removed
the SSE transport these tools were configured against. To use them again,
point OpenCode/Cursor configs at streamable HTTP
(`http://127.0.0.1:8050/mcp`) — the old `:8000/sse` examples below no longer
work. The hub itself is started once per machine (see One-time setup above).

### Bootstrap a new project from the template

```bash
git clone https://github.com/mdvacula/agent-template my-project
cd my-project

# Edit the two placeholder files
#   openspec/config.yaml      — fill in PROJECT_NAME, TECH_STACK
#   AGENTS.md                 — replace PROJECT_NAME references

# Wire up git notes fetch refspec (run once per clone)
git config --add remote.origin.fetch '+refs/notes/*:refs/notes/*'
```

### Verify the MCP connection

Open OpenCode in your project and run:

```
fetch_tasks(status="pending")
```

An empty array `[]` confirms the hub is reachable and the MCP tool is wired up.

OpenCode projects point `opencode.json` at the hub (v2 transport):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "task-hub": { "type": "remote", "url": "http://127.0.0.1:8050/mcp", "enabled": true }
  }
}
```

### Bootstrap an existing project

Instead of cloning the template, invoke the `agentic-setup` skill directly
from inside your project in OpenCode:

```
/skill agentic-setup
```

### Run integration tests (optional)

```bash
# From agent-kit, with hub running
python -m pytest tests/test_hub_integration.py -v
```

### What the legacy harness unlocks

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
