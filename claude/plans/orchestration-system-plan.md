<!-- Origin: ~/.claude/plans/cheeky-exploring-meerkat.md (Claude Code plan-mode file from session 422e4dcb, 2026-08-27). Copied verbatim below. -->

# Claude Code orchestration system: task-hub revival + tiered agents + shadcn UI

## Context

mdv previously ran a spec-driven multi-agent workflow under opencode/pi: OpenSpec changes → tasks synced to a **mcp-task-hub** MCP server (SQLite + SSE, Docker) → an orchestrator agent drained the queue by fanning out runner subagents. The hub container is gone, its old port (8000) is now the alpaca-bot dashboard, and the agents only exist as project-local copies in `beatpath/.claude/agents/`. Goal: rebuild this natively on Claude Code — **Fable 5 (main session) as planner + orchestrator**, cheaper models as workers, **Opus as reviewer** — improved with a review-before-push gate, per-task model tiers, per-project task namespacing, and a **shadcn/React web UI** to see the queue. Pilot: **newjerseybrews**.

User decisions: revive+upgrade the hub; 3 worker tiers (haiku/sonnet/opus) with Opus reviewers; pilot newjerseybrews; build a shadcn React task viewer; OK to clone & push to `mdvacula/mcp-task-hub` and `mdvacula/agent-kit` (but wary of the pi-agent GitHub Actions — disable, don't use).

Constraints (from memory/CLAUDE.md): no headless `claude -p` automation — orchestration is in-session only; pause + escalate to user on failure; don't touch live services; 127.0.0.1 = local tier, LAN exposure only via gateway nginx + mDNS with auth decided; containers as `user: "1000:1000"` with bind mounts.

## Phase 1 — Revive + upgrade the hub (`~/infra/task-hub`)

Clone `git@github.com:mdvacula/mcp-task-hub.git` → `~/infra/task-hub` (checkout = deployment dir, like other `~/infra/*` services). Commit upgrades directly to `main` and push. Fresh DB at `./data/hub.db` (don't migrate the old 394-task volume). `.gitignore` `data/`.

Upgrades:
1. **Streamable HTTP transport** (SSE is deprecated): delete the hand-rolled Starlette composition in `main.py`; use `FastMCP("task-hub", stateless_http=True, json_response=True, lifespan=...)` with `mcp.run(transport="streamable-http")`. MCP at `/mcp`; keep `GET /health`, `/tasks`, `/tasks/{id}` via `@mcp.custom_route`. Pin `mcp[cli]>=1.12`.
2. **`project` as a first-class column** (fixes the flat 394-task namespace): idempotent `ALTER TABLE` migration in `store.connect()`, index, `sync_task(..., project=None)` + `fetch_tasks(..., project=None)` SQL filter; move the `change` filter into SQL (`json_extract`) too. Convention: `project` = repo dir name.
3. **`update_task_status(id, status, notes=None)`**: notes appended to `metadata.statusNotes` with timestamp; `status="blocked"` **requires** notes (ValueError otherwise).
4. **Own observability, no Entire**: the old stack's `.entire/` session capture and `entireSessionId` metadata key are dropped everywhere (schema, spec, skills — don't port `plugins/entire.ts`). Replacement v1 is hub-native: `hub-run` writes `metadata.runLog` entries per task — worker model/tier, commit range, gate results, reviewer verdict + findings, fix-cycle count — so every task carries its own execution trace, rendered in the UI (Phase 2 row expand). Deeper session capture (our own design) is explicitly deferred future work.
5. Tests for migration, project filter, blocked-requires-notes (`tests/` already exist).

Compose (per box conventions): `container_name: task-hub`, `restart: unless-stopped` (infra tier — allowed), `user: "1000:1000"`, `HOME=/tmp`, `ports: "127.0.0.1:8050:8000"` (8050 verified free), `volumes: ./data:/data`, keep healthcheck. Keep the existing pip Dockerfile (becomes multi-stage with the UI build, Phase 2).

Register user-wide: `claude mcp add --scope user --transport http task-hub http://127.0.0.1:8050/mcp`.

Cleanup: point beatpath's `opencode.json` task-hub entry at the new URL (or drop it) so the dead `localhost:8000` reference stops hitting the alpaca dashboard.

## Phase 2 — shadcn/React task viewer (served by the hub)

New `ui/` dir in the mcp-task-hub repo: **Vite + React + TS + Tailwind v4 + shadcn/ui**, dark-mode default. Read-only — talks to the hub's existing JSON endpoints (same origin, no CORS needed):
- Header stat tiles (pending / in-progress / blocked / completed counts, per project).
- Filterable task table: project, change, status, priority, tier; status/priority badges; sortable.
- Row expand/sheet: full metadata, `blockedBy`/`blocks`, `statusNotes` (why blocked), timestamps.
- Poll `/tasks` every ~5s; stale in-progress highlighting (updated_at > 2h → likely orphaned claim).

Serving: multi-stage Dockerfile (node build stage → static assets copied into the Python image), mounted at `/ui` (StaticFiles on the streamable-http app; MCP stays at `/mcp` — mind the mount-order gotcha that bit the SSE version).

**Exposure so the MacBook browser can reach it** (tier 2, per gateway conventions): nginx vhost `~/infra/gateway/nginx/conf.d/taskhub.conf` for `taskhub.local` → `192.168.1.134:8050`... proxied **allowlist only**: `/ui`, `/tasks`, `/health`. **`/mcp` is NOT proxied** — writes stay loopback-only for Claude Code. Add `taskhub` to the mdns publisher aliases. (Auth decision: unauthenticated read-only view on trusted LAN — consistent with existing tier-2 services.) The 8050 port itself stays bound to 127.0.0.1; nginx (host-networked) reaches it locally, so no new ufw rule beyond the existing port-80 one.

## Phase 3 — Global agents (`~/.claude/agents/`, greenfield)

**Key change vs old system: workers never push. Review gates before push.** The old "not done until pushed" invariant caused pull-rebase races; durability now comes from the main session owning the drain loop and pushing after review.

- **`hub-worker.md`** — `model: sonnet`, tools: Bash, Read, Edit, Write, Grep, Glob + task-hub MCP (no Agent — leaf node). Protocol (adapted from beatpath's hub-runner): fetch task → claim `in-progress` → record base SHA → read CLAUDE.md/AGENTS.md + `specRef` → implement minimally → run repo gates (e.g. `pnpm lint` / `type-check` / `test`) → zero-bloat check (`git diff --cached --name-only`: no .jsonl/.sqlite/.db/task sidecars) → local commit referencing task id → tick tasks.md checkbox → `completed` → report commit range + gate results. **No push/pull.** Blocked path: `update_task_status(blocked, notes=reason+options)`, stop — never guess.
- **`hub-worker-haiku.md` / `hub-worker-opus.md`** — 3-line bodies: "Read hub-worker.md and follow its protocol exactly; you are the <tier> tier." Only `model:` differs. No drift.
- **`hub-reviewer.md`** — `model: opus`, read-only tools (Bash convention-restricted, Read, Grep, Glob + hub MCP). Input: task id + commit range. Checks: spec/task conformance, repo-guardrail compliance, re-run type/test gates, zero-bloat, scope creep. Structured output: `VERDICT: PASS|FAIL` + findings `{file:line, severity blocker|major|minor, issue, required-fix}`. Only blocker/major force FAIL.

**Fix cycles**: subagents can't be re-messaged after returning, so a FAIL spawns a *fresh* worker with the findings ("amend with follow-up commits, don't re-implement"). Cycle 1 same tier, cycle 2 bump one tier. After 2 failed cycles → task `blocked` with findings, **pause the drain, present options to user** (old escalation rule preserved).

## Phase 4 — Skills: official OpenSpec tooling for specs + new global `/hub-*` layer

**Spec layer = the official OpenSpec tooling.** The `opsx` commands and `openspec-*` skills (propose, explore, apply, verify, archive, sync-specs, …) are generated by `npx @fission-ai/openspec init/update --tools claude` — they are the real spec-creation workflow, not beatpath-specific. Every participating repo gets them: run `openspec update`/`init --tools claude` in newjerseybrews (currently only has `.cursor` variants), alpaca-bot, and sindex as they onboard; beatpath already has them. Spec creation, verification, and archiving always go through `/opsx:propose|ff|verify|archive` (or the matching `openspec-*` skills) — the hub layer never reinvents artifact authoring.

**Hub layer = new global skills** (`~/.claude/skills/`, `/hub-*` namespace) that sit on top:

- **`hub-plan`** — planning (Fable, main session): create/refresh the openspec change via `openspec-propose`/`opsx ff` (official skills) → **mandatory reconciliation audit** (each tasks.md item vs actual codebase + superseding docs → classify done / obsolete / todo; present to user before syncing — load-bearing: newjerseybrews' p1-3 is largely superseded) → chunk into hub tasks at **subsection granularity** (3–8 checkboxes per task, target 10–20 hub tasks per change, never 1:1 with 119 checkboxes) → `sync_task` with `project`, stable id `<change-id>-<slug>`, metadata `{change, priority, type, tier, specRef, blocks, blockedBy}`.
  After a drain completes, close the loop with the official tooling: `openspec-verify-change` to validate implementation against artifacts, then `/opsx:archive` to archive the change and sync specs.
- **`hub-drain`** — the drain loop as a **saved dynamic workflow** (`~/.claude/workflows/hub-drain`, invoked `/hub-drain` with `args {project, change?, maxTasks?}`; docs: code.claude.com/docs/en/workflows). Deterministic script, sequential (one task in flight):
  1. Preflight agent: clean tree check, `git pull --rebase`, hub `/health`.
  2. Loop: `fetch_tasks(pending, project[, change])` → pick next by P0→P2 with `blockedBy` satisfied → `agent(task, {agentType: 'hub-worker', model: metadata.tier})` → on success `agent(review, {agentType: 'hub-reviewer'})` (Opus) → FAIL: fix-cycle respawn (max 2, tier-bump on 2nd) → after PASS, a small haiku git-steward agent does the checkpoint `pull --rebase && push` (zero-bloat re-check) every ~3 reviewed tasks and at drain end. Each task's outcome appended to `metadata.runLog`.
  3. **Failure handling — workflows can't prompt mid-run**, so on any blocker (worker blocked, gates unfixable, 2 failed review cycles) the script marks the task `blocked` with notes and **returns early with a structured report**. Fable (main session) then presents **{retry | skip | abort | investigate}** and relaunches `/hub-drain` — hub state makes relaunch idempotent (completed tasks aren't refetched). The old pause-and-escalate rule, adapted to the runtime.
  Sequential is deliberate for the pilot (shared `payload-types.ts`, `.next`, lockfile contention); **parallel workers via `isolation: 'worktree'`** is the documented later upgrade once a full drain has proven out — the workflow runtime supports it natively.
- **`hub-status`** — skill: `curl /health` + `fetch_tasks` per status, grouped by project→change; blocked tasks with notes; stale-claim detection with offer to reset to pending. (Or just open `taskhub.local/ui`.)

Note: workflow subagents run in `acceptEdits` mode and inherit the tool allowlist — before the first real drain, allowlist the repo's gate commands (`pnpm lint/type-check/test`, git basics) in the project's `.claude/settings.json` so the run doesn't stall on permission prompts (`/fewer-permission-prompts` can help).

**Tier rubric** (applied by hub-plan, `metadata.tier`): **haiku** = mechanical, fully specified, ≤2 files, no new tests (renames, config, copy); **sonnet** = default (features, tests, multi-file following existing patterns); **opus** = schema/migrations, algorithmic/fuzzy logic, auth/security, concurrency, or flagged-ambiguous. Escalation only bumps up; reviewer always opus; user override wins.

## Phase 5 — agent-kit repo: canonical multi-tool store (nothing removed)

Clone `mdvacula/agent-kit` → `~/code/agent-kit` and reorganize it as a **multi-tool kit — all existing tool targets are retained**, none deleted:

- **Keep in place**: `.agents/skills/` (opencode: agentic-setup, mcp-hub-setup), `commands/pi/` (hub-run etc.), any cursor assets, `specs/` — existing opencode/pi/cursor consumers keep working from their current paths.
- **Add** a `claude/` tree: `claude/agents/{hub-worker,hub-worker-haiku,hub-worker-opus,hub-reviewer}.md`, `claude/skills/{hub-plan,hub-status}/`, `claude/workflows/hub-drain`, plus a manual `install.sh` (cp into `~/.claude/` — no symlinks, no automation, run by hand).
- **README**: document the per-tool layout (opencode / pi / cursor / claude targets, shared specs) and which generation of the workflow each represents.
- **Neutralize the GitHub Actions FIRST, in the first commit** (`sync-template.yml`, `sync-hub.yml` → `.github/workflows-disabled/`): they spin up a pi agent on push and regenerate `agent-template` / `mcp-task-hub` from the specs — which would both spawn an unattended agent and **overwrite the hub changes we're pushing directly**. Disabling before any other push is load-bearing.
- **Update `specs/mcp-task-hub/spec.md`** to describe the upgraded hub (streamable HTTP, `project` column, blocked-notes, `runLog`, `/ui`; `entireSessionId` removed) — the repo's own rule is "the spec wins," so the spec must not describe the old SSE design.

Push to main (workflows are disabled by then, so pushes are inert).

## Phase 6 — Pilot on newjerseybrews

Plan-agent audit findings: **p1-3-data-enrichment (0/119) is largely superseded** — enrichment engine already exists (`scripts/research/`, write contract, lock fields) and `sources.md` forbids its two pillars (persisting Google Places details; Untappd bulk API is dead). **p2-2 map view is partially built** (maplibre, `BreweryMap.tsx`, `/map` route exist). Repo is ~53 commits ahead of origin.

1. `git push` newjerseybrews first (clean review baselines); run `npx @fission-ai/openspec@latest update` / `init --tools claude` there so the full `/opsx` command + skill set is available.
2. Smoke test: one synthetic P2 chore task through the full claim → implement → review → push pipeline.
3. `/hub-plan` audit on **p1-3**: expect most boxes marked done/obsolete; sync only the genuine remainder. (The audit itself fixes the repo's stale tracking — valuable output.)
4. First real drain: **p2-2-interactive-map-view** — reconcile (tick built parts), sync the true remainder (~8–12 tiered tasks: clustering, popups, filter↔map sync, mobile), then `/hub-drain` with `maxTasks: 3` for the babysat first batch (watch via `/workflows` + the UI), then drain the rest.

## Scope fences (NOT building)

No headless/`claude -p`/cron/systemd-spawned Claude runs. No auto-restart of agent processes (hub container `unless-stopped` is the one allowed infra exception). No LAN/tunnel exposure of the MCP write path — `/mcp` loopback-only; only `/ui`+`/tasks`+`/health` behind the gateway. No GitHub-Action agent builders. No Entire (`.entire/`, `entireSessionId`, `plugins/entire.ts`) — observability is our own hub-native `runLog` (v1), custom session capture designed later. No reinventing spec authoring — artifacts always via official OpenSpec (`opsx`) tooling.

## Verification

1. **Hub**: `pytest` green; `docker compose up -d --build`; `curl 127.0.0.1:8050/health` → `{"status":"ok","task_count":0}`; `ss -ltn` shows 8050 on 127.0.0.1 only; survives `docker restart task-hub` with data intact.
2. **MCP**: `claude mcp list` shows task-hub; probe `sync_task` from one project not visible under another project filter.
3. **UI**: `taskhub.local/ui` renders from the MacBook; `curl taskhub.local/mcp` → 404/403 (write path blocked at nginx); tasks appear live while a drain runs.
4. **Agents**: synthetic-chore pipeline ends with a reviewed, pushed commit + hub task `completed`; forced-block test shows `blocked`+notes, drain pauses with options.
5. **Pilot exit**: p2-2 remainder drained sequentially, every commit task-id-referenced and reviewed-before-push, no bloat files, newjerseybrews queue empty, UI reflects it.
