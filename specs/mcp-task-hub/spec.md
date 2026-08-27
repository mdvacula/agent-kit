# MCP Task Hub — spec (v2)

> **Status**: v2, matches `mdvacula/mcp-task-hub@main` (2026-08). The repo is
> edited directly; this spec is the behavioral contract, not a code template.
> The pi regeneration workflow that consumed the v1 spec is disabled — this
> document no longer embeds implementation source.

## Overview

Centralized task execution state for agentic coding workflows. Runs as a Docker
container; agents connect via **MCP streamable HTTP** (the SSE transport was
removed in v2). One hub serves many repos — tasks are namespaced by `project`.

- Planner (`/hub-plan`) upserts tasks with `sync_task`.
- Workers claim/complete with `update_task_status`.
- The drain workflow and humans read via `fetch_tasks`, the read-only HTTP
  endpoints, and the bundled web UI.

## Data model

`tasks` table (SQLite via aiosqlite, `HUB_DB_PATH`):

| column | type | notes |
|---|---|---|
| `id` | TEXT PK | stable kebab-case: `<change-id>-<task-slug>` |
| `title` | TEXT | imperative summary |
| `status` | TEXT | `pending` \| `in-progress` \| `completed` \| `blocked` — validated, invalid values raise |
| `project` | TEXT | **v2, first-class + indexed** — owning repo dir name. Idempotent `ALTER TABLE` migration adds it to v1 databases |
| `metadata` | TEXT JSON | see below |
| `created_at`, `updated_at` | TEXT | UTC ISO-8601 |

### Standard metadata keys

`change` (OpenSpec change id), `specRef` (path into spec artifacts), `priority`
(`P0`|`P1`|`P2`), `type` (`task`|`feature`|`chore`), `tier`
(`haiku`|`sonnet`|`opus` — worker model tier), `blockedBy[]`, `blocks[]`,
`statusNotes[]` (v2 — appended `{at, status, note}` entries),
`runLog[]` (v2 — one entry per drain execution: agent, tier, commitRange,
gates, verdict, findingsCount, fixCycles, summary).

**Removed in v2**: `entireSessionId` (Entire is not used; `runLog` is the
observability layer).

## MCP tools

### `sync_task(id, title, status=None, metadata=None, project=None)`
Upsert. Creates as `pending`; on update merges metadata **top-level keys**
(callers appending to `statusNotes`/`runLog` must send the full array), changes
status only when explicitly supplied, keeps existing `project` when the arg is
omitted. Returns the full record.

### `fetch_tasks(id=None, status=None, change=None, project=None)`
All filters ANDed **in SQL** (v2: `change` via `json_extract`, `project` via
the column). Returns `[]` on no match, never errors. Sorted P0→P1→P2→none,
then `created_at`.

### `update_task_status(id, status, notes=None)`
Raises `ValueError` if the id is missing or the status invalid.
**v2: `status="blocked"` without `notes` is rejected** — a blocked task must
say why. When `notes` is given, an entry `{at, status, note}` is appended to
`metadata.statusNotes`.

## HTTP endpoints (read-only)

- `GET /health` → `{"status": "ok", "task_count": N}`
- `GET /tasks` → all tasks
- `GET /tasks/{id}` → one task or 404
- `GET /ui/` → **v2** bundled task viewer (Vite + React + Tailwind v4 +
  shadcn/ui, dark default): stat tiles, project/change/status filters, search,
  detail sheet with statusNotes + runLog, stale-claim (>2 h in-progress)
  highlighting, 5 s polling. Static build served by the hub itself
  (`HUB_UI_DIR`, default `/app/ui`); SPA fallback to `index.html`;
  path-traversal guarded.

Writes happen only through MCP tools. When exposing the viewer beyond
localhost, proxy only `/ui`, `/tasks`, `/health` — never `/mcp`.

## Transport

FastMCP (**`mcp[cli]>=1.12,<2`** — v2.x of the SDK renamed FastMCP and dropped
`custom_route`; do not upgrade casually) running
`transport="streamable-http"` with `stateless_http=True, json_response=True`.
MCP endpoint: **`/mcp`**. The custom HTTP routes are registered via
`@mcp.custom_route`. There is no hand-rolled Starlette composition and no SSE
app — the v1 mount-path pitfall class is gone.

The store connects lazily on first use (no lifespan wiring; stateless mode may
construct server instances per request). A failed `connect()` must close its
connection — a leaked aiosqlite thread hangs process exit.

Claude Code registration:
`claude mcp add --scope user --transport http task-hub http://127.0.0.1:8050/mcp`

## Deployment

Multi-stage Dockerfile: `node:24-slim` + pnpm builds `ui/` → dist copied into
`python:3.12-slim` runtime at `/app/ui`. Compose (omarchy box conventions):
`container_name: task-hub`, `user: "1000:1000"`, `HOME=/tmp`,
`127.0.0.1:8050:8000` (local-only tier; 8000 on the box belongs to something
else), bind mount `./data:/data` (not a named volume), `restart:
unless-stopped`, urllib healthcheck against `/health`.

Env (`.env`): `HUB_HOST=0.0.0.0`, `HUB_PORT=8000`, `HUB_DB_PATH=/data/hub.db`,
`HUB_LOG_LEVEL=INFO`, `HUB_UI_DIR=/app/ui`.

## Tests

`pytest` + `pytest-asyncio` (auto mode). Coverage must include: CRUD + merge
semantics, all four filters, priority ordering, **the v1→v2 migration** (build
an old-schema DB by hand, connect, verify column + writes), blocked-requires-
notes, statusNotes append, invalid-status rejection, HTTP endpoints, UI 404
when unbuilt, and that `streamable_http_app()` exposes both `/mcp` and the
custom routes.

## Known pitfalls

1. **Index on `project` cannot live in the base SCHEMA script** — on a v1
   database the schema script runs before the migration adds the column and
   `CREATE INDEX` explodes. Create the index in the migration step, after the
   column exists.
2. **Leaked aiosqlite connections hang the process at exit** (non-daemon
   thread). Any failure path in `connect()` must close the connection.
3. `sync_task` metadata merge is shallow — array fields are replaced, not
   appended. The hub-steward agent reads-then-writes full arrays.
4. Port 8000 must not be assumed free on the host — on the omarchy box it is
   the alpaca-bot dashboard. The hub's host port is 8050.

## Non-functional

Single-writer SQLite is fine at this scale (hundreds of tasks, sequential
drains). No auth on the loopback interface; LAN exposure is read-only-proxy
only; public exposure is out of scope.
