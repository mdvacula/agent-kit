# Building an Autonomous Coding Harness in a Day

**Everything we built, why we built it, and how the pieces fit together**

---

There's a version of AI-assisted development that looks like this: you describe a requirement, an agent writes the code, commits it with a traceable record of why, marks the task done, and moves to the next one — without you babysitting it. Today we built the infrastructure to make that real.

Here's what we actually shipped, end to end.

---

## The Problem

AI coding agents are powerful but stateless. Every session starts from scratch. There's no shared task queue, no record of what was done and why, no way to hand work between agents or pick up where you left off. The result is a lot of copy-pasted context, re-explaining the same codebase, and agents doing redundant work.

We wanted something different: a minimal, zero-bloat harness where task state lives in a hub, agent decisions leave a permanent record in the repo itself, and any agent — OpenCode, pi, or a headless CI runner — can pick up work and execute it without human handholding.

---

## The Architecture

Three repos. One principle.

```
agent-kit          ← source of truth (skills, agents, specs, CI)
    │
    ├── sync-hub.yml      → mcp-task-hub   (Docker service)
    └── sync-template.yml → agent-template (project scaffold)
```

**`agent-kit`** is where everything is defined. Skills, agent definitions, prompt templates, specs. When something changes here, GitHub Actions fires a pi agent to regenerate the downstream repos automatically.

**`mcp-task-hub`** is a Docker container that runs locally and exposes three MCP tools over SSE: `sync_task`, `fetch_tasks`, `update_task_status`. Every project's agents connect to it. It's the single source of truth for what work is pending, in progress, or done.

**`agent-template`** is what a developer clones to start a new project. It has everything wired up from day one: OpenCode agents, pi prompts, OpenSpec commands, hub config, AGENTS.md workflow reference.

**The guiding principle: zero bloat.** Task state lives in the hub. Observability lives in git notes. No JSONL sidecars, no SQLite files, no task markdown trackers ever committed.

---

## Git Notes: The AI Blame Layer

Every task commit gets a Git Note attached to `refs/notes/agent-log`:

```json
{
  "agent": "opencode",
  "model": "openrouter/anthropic/claude-sonnet-4.6",
  "task_id": "agent-kit-integration-tests-ci",
  "spec_ref": "specs/agent-kit/spec.md",
  "summary": "Add CI workflow that builds hub via docker compose and runs integration tests"
}
```

This is stored inside the repo's own object database — not in a file, not in a third-party service. Run `git log --show-notes=agent-log --oneline` and you get a complete record of every AI decision, attached to the exact commit it produced. Push them with `git push origin HEAD refs/notes/agent-log` and the record travels with the repo.

We called this the AI blame layer. It answers the question "why does this line of code exist?" not just for humans, but specifically for AI agents that made the change.

---

## The MCP Task Hub

The hub is a Python/Starlette service running in Docker. It exposes:

- **Three MCP tools** over SSE: `sync_task` (upsert), `fetch_tasks` (query with priority ordering), `update_task_status` (transitions)
- **Three HTTP endpoints** for scripting and CI: `/health`, `/tasks`, `/tasks/{id}`
- **SQLite persistence** mounted as a Docker volume — data survives restarts

Important: the generated hub must actually mount the MCP transport at `/sse`.
If `/health` works but `/sse` returns 404, OpenCode will fail to connect even
though the container appears healthy.

Tasks have a `metadata` bag for things like `priority` (P0/P1/P2), `specRef`, `change`, `blockedBy`. `fetch_tasks` returns results ordered by priority then creation time, so agents always work highest-priority first.

The whole thing is about 300 lines of Python, passes 14 unit tests, and has a 10-test integration suite in `agent-kit` that spins up the real container in CI.

---

## The Living Spec

Requirements live in `openspec/specs/living-spec.md` — a plain markdown file with checkboxes. Agents parse it, sync unchecked items to the hub as tasks, and tick them off as work lands. It's the source of truth that connects human intent to machine execution.

When you want new work done:

```
/opsx-propose   ← idea → spec change → tasks synced to hub
```

When you want work executed:

```
/hub-run        ← pi picks next pending task, implements, commits, pushes, closes
@hub-runner     ← same thing in OpenCode
@hub-orchestrator ← runs the entire backlog in parallel
```

---

## The CI Pipeline

Two GitHub Actions workflows propagate changes from `agent-kit` to the downstream repos:

- **`sync-hub.yml`** — fires when `specs/mcp-task-hub/spec.md` or the hub skill changes. Runs a pi agent (Mode B) to regenerate `mcp-task-hub`, opens a PR.
- **`sync-template.yml`** — fires when agents, skills, or commands change. Runs a pi agent (Mode B) to regenerate `agent-template`, opens a PR.

Both use `openai/gpt-5.4-nano` via OpenRouter at $0.20/1M tokens — the task is pure file writing, no reasoning chains needed. The agent also writes `/tmp/pr-title.txt` and `/tmp/pr-body.md` so the PRs have meaningful titles describing what actually changed, not just a SHA.

Getting this working involved more yak-shaving than expected:

- `pnpm` not installed on GitHub runners → back to `npm`
- pi's `@file` resolves relative to cwd, not as absolute path → pipe skill via stdin instead
- YAML frontmatter `---` parsed as unknown CLI flag → use `cat skill | pi -p "instructions"`
- Model echoing back the heredoc delimiter into the PR body → Python script with `secrets.token_hex(32)` delimiter, never visible in the prompt context
- Inline `python3 -c` with braces misread by YAML parser → extracted to `.github/scripts/write_pr_body.py`

Each fix was one commit. The workflow went from echo stubs to fully functional in an afternoon.

---

## The `/hub-run` Prompt

The centrepiece of the execution loop. A pi prompt template that encodes the complete task lifecycle:

1. `fetch_tasks(status="pending")` → take the first result (P0 first)
2. Claim it: `update_task_status(id, "in-progress")`
3. Read `AGENTS.md`, the relevant spec section, neighbouring code
4. Implement
5. Quality gates (test, lint, typecheck — whatever exists)
6. Zero-bloat check: no `.jsonl`, `.sqlite`, `.db` in the diff
7. `git commit`
8. `git notes --ref=agent-log add -m '{"agent":"pi","task_id":"...","summary":"..."}'`
9. `update_task_status(id, "completed")`
10. Mark requirement done in the living spec
11. `git push origin HEAD refs/notes/agent-log`

Work is not done until all eleven steps are true. The prompt is explicit about this — "Done means done."

---

## We Ate Our Own Dog Food

Rather than leaving the hub empty, we seeded it with two real open items from `agent-kit`'s own spec and ran the loop:

**Task 1 (P1):** Add integration tests to CI — hub as a Docker service in the workflow.

Result: `.github/workflows/test.yml` — checks out `mcp-task-hub`, builds it with `docker compose`, waits for `/health`, runs the integration suite. Passes on first try.

**Task 2 (P2):** Add at least one non-stub file to `skills/`.

Result: `skills/shared/git-notes/SKILL.md` — a loadable skill that teaches agents the git notes workflow. Concise, reusable, ships in every bootstrapped project.

Both tasks were claimed, implemented, committed with git notes, marked complete on the hub, and pushed — the full loop, not simulated.

---

## What's Left

A few things we deliberately didn't finish:

- **`mcp-task-hub` needs a GitHub Container Registry image** — the integration test workflow currently rebuilds the hub from source on every run. Publishing `ghcr.io/mdvacula/mcp-task-hub:latest` would make the CI step significantly faster.
- **The `@hub-orchestrator` parallel path** — works in theory (hub-runner as a sub-agent), hasn't been exercised end-to-end with real concurrent tasks.
- **Auth** — the hub assumes a trusted local network. Fine for now. Not fine if you want to share it across machines or expose it remotely.

---

## The Stack

| Layer | Tool | Cost |
|-------|------|------|
| Primary agent | OpenCode (this session) | — |
| CI agent | pi (`@mariozechner/pi-coding-agent`) | — |
| Model (CI) | `openai/gpt-5.4-nano` via OpenRouter | $0.20/1M tokens |
| Task hub | Python + Starlette + aiosqlite + Docker | free / self-hosted |
| Spec management | OpenSpec (`@fission-ai/openspec`) | free |
| Observability | Git Notes (`refs/notes/agent-log`) | free |
| Downstream sync | `peter-evans/create-pull-request` | free |

The only runtime cost is the OpenRouter calls in CI — about $0.002 per workflow run at current token counts.

---

## Source

- `agent-kit`: https://github.com/mdvacula/agent-kit
- `mcp-task-hub`: https://github.com/mdvacula/mcp-task-hub
- `agent-template`: https://github.com/mdvacula/agent-template
