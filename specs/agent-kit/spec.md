# agent-kit

**Capability:** Source of truth for agentic infrastructure — skills, agents, specs, and CI  
**Status:** Active  
**Priority:** P0 — this repo governs everything downstream

---

## Overview

`agent-kit` is the authoritative source for the skills, agents, commands, and
specifications that power autonomous coding workflows. It does not run any code
itself — it generates two downstream repos via GitHub Actions and provides
discoverable skills for local use.

### Three-repo model

```
agent-kit  (this repo — source of truth)
    │
    ├── sync-hub.yml ──────→  mcp-task-hub  (Docker service)
    └── sync-template.yml ─→  agent-template (project scaffold)
```

Changes to `agent-kit` propagate downstream via PR. Humans review and merge.

---

## Components

### `.agents/skills/` — auto-discovered skills

Both OpenCode and pi discover skills by walking up the directory tree looking
for `.agents/skills/`. No per-project installation is required when working
inside or alongside `agent-kit`.

| Skill | File | Purpose |
|-------|------|---------|
| `agentic-setup` | `.agents/skills/agentic-setup/SKILL.md` | Bootstrap a project (Mode A: local, Mode B: template generation) |
| `mcp-hub-setup` | `.agents/skills/mcp-hub-setup/SKILL.md` | Set up the MCP Task Hub (Mode A: local, Mode B: generate hub repo) |

Each skill ships a `REFERENCE.md` one-page checklist alongside `SKILL.md`.

### `agents/opencode/` — OpenCode agent definitions

Pi has no agent concept. These are OpenCode-only.

| Agent | Purpose |
|-------|---------|
| `hub-runner.md` | Execute one task end-to-end: claim → implement → commit → close |
| `hub-orchestrator.md` | Coordinate parallel hub-runner subagents across a work queue |
| `openspec-orchestrator.md` | Plan: parse living spec → sync tasks → hand off to hub-orchestrator |

`.opencode/agents/` contains symlinks to these files so OpenCode discovers them
when editing agent-kit itself without duplicating content.

### `skills/` and `commands/` — per-project install

These directories are copied into new projects by the `agentic-setup` skill.
They are separate from `.agents/skills/` (which is auto-discovered).

| Directory | Contents |
|-----------|---------|
| `skills/shared/` | Skills that work in both OpenCode and pi |
| `skills/opencode/` | OpenCode-specific skills |
| `skills/pi/` | pi-specific skills |
| `commands/shared/` | Slash commands / prompts for both tools |
| `commands/opencode/` | OpenCode commands (`.opencode/commands/`) |
| `commands/pi/` | pi prompt templates (`.pi/prompts/`) — supports `$1`/`$@` args |

**Installed pi prompt templates:**

| Prompt | Invocation | Purpose |
|--------|-----------|---------|
| `hub-run.md` | `/hub-run` | Pick next pending task from hub, execute end-to-end, push, close |

### `specs/` — living specs for kit components

| Spec | Subject |
|------|---------|
| `specs/mcp-task-hub/spec.md` | MCP Task Hub service — data model, tools, HTTP endpoints |
| `specs/agent-kit/spec.md` | This file — the kit itself |

Specs drive the Mode B skill prompts. When a spec changes, the corresponding
GitHub Action runs a pi agent to regenerate the downstream repo.

### `.github/workflows/` — CI propagation

| Workflow | Trigger | Action |
|----------|---------|--------|
| `sync-hub.yml` | Changes to `.agents/skills/mcp-hub-setup/` or `specs/mcp-task-hub/` | pi agent (`anthropic/claude-sonnet-4-6` via OpenRouter) → PR on `mcp-task-hub` |
| `sync-template.yml` | Changes to `agents/`, `.agents/skills/agentic-setup/`, `skills/`, or `commands/` | pi agent (`anthropic/claude-sonnet-4-6` via OpenRouter) → PR on `agent-template` |

---

## Maintenance Workflow

### Making a change to the hub

1. Edit `specs/mcp-task-hub/spec.md` — describe what changed and why
2. Edit `.agents/skills/mcp-hub-setup/SKILL.md` — update the source templates
3. Push to `main` → `sync-hub.yml` fires → pi regenerates `mcp-task-hub` → open PR
4. Review and merge the PR on `mcp-task-hub`
5. Run `docker compose pull && docker compose up -d --build` locally

### Making a change to the project scaffold

1. Edit the relevant skill, agent, or command file
2. Push to `main` → `sync-template.yml` fires → pi regenerates `agent-template` → open PR
3. Review and merge the PR on `agent-template`

### Adding a new skill

1. Create `.agents/skills/<name>/SKILL.md` (and optionally `REFERENCE.md`)
2. Add copy instructions to `agentic-setup` SKILL.md (Mode A step A5, Mode B step B3)
3. Push — `sync-template.yml` will pick it up

---

## Integration Tests

`agent-kit` owns smoke tests that verify the live hub from a consumer perspective.
These run against `http://localhost:8000` and confirm the hub contract matches
what the skills and agents expect.

```bash
# Requires hub running: docker compose -f ~/mcp-task-hub/docker-compose.yml up -d
python -m pytest tests/ -v
```

Tests live in `tests/test_hub_integration.py`.

---

## Acceptance Criteria

- [x] `.agents/skills/agentic-setup/SKILL.md` covers both Mode A and Mode B
- [x] `.agents/skills/mcp-hub-setup/SKILL.md` covers both Mode A and Mode B
- [x] All three OpenCode agent definitions exist in `agents/opencode/`
- [x] `.opencode/agents/` symlinks point to `agents/opencode/`
- [x] `specs/mcp-task-hub/spec.md` is accurate and up to date
- [x] `specs/agent-kit/spec.md` exists (this file)
- [x] `sync-hub.yml` runs a real pi agent (`@mariozechner/pi-coding-agent` via OpenRouter)
- [x] `sync-template.yml` runs a real pi agent (`@mariozechner/pi-coding-agent` via OpenRouter)
- [x] Integration tests exist in `tests/test_hub_integration.py`
- [x] Integration tests run in CI (hub built via docker compose in `.github/workflows/test.yml`)
- [x] `commands/pi/hub-run.md` exists — pi prompt for end-to-end task execution
- [ ] `skills/` directory contains at least one non-stub file

---

## Non-Goals

- `agent-kit` does not run application code
- `agent-kit` does not store task state (that's the hub's job)
- `agent-kit` does not generate project-specific files at rest (generated on demand by skills)
