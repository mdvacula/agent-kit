# MCP Task Hub

**Capability:** Centralized task execution state over Model Context Protocol  
**Status:** Implemented  
**Priority:** P0 — everything else depends on this

---

## Overview

A lightweight, self-hostable server that exposes task state to AI agents via
the Model Context Protocol. Agents connect over SSE and use three tools to
manage the full task lifecycle. Persistence is a local SQLite database managed
by the server — never by the repo or the agent.

The task schema follows the [TaskMD](https://driangle.github.io/taskmd/) model:
each record carries a stable ID, a title, a status, and a free-form metadata
bag that agents use to link tasks back to spec references, priority, dependency
chains, and session recordings.

---

## Data Model

### Task record

| Field | Type | Notes |
|-------|------|-------|
| `id` | `TEXT PRIMARY KEY` | Stable kebab-case slug, e.g. `auth-implement-jwt` |
| `title` | `TEXT NOT NULL` | Human-readable task title |
| `status` | `TEXT NOT NULL` | `pending` · `in-progress` · `completed` · `blocked` |
| `metadata` | `TEXT` | JSON blob — see standard keys below |
| `created_at` | `TEXT` | ISO-8601, set on insert |
| `updated_at` | `TEXT` | ISO-8601, updated on every write |

### Standard metadata keys

Agents should use these keys consistently so the hub can be queried predictably.

| Key | Type | Description |
|-----|------|-------------|
| `change` | string | OpenSpec change ID that produced this task |
| `specRef` | string | Path to the requirement in the Living Spec |
| `priority` | string | `P0` · `P1` · `P2` |
| `type` | string | `task` · `feature` · `chore` |
| `blockedBy` | string[] | IDs of tasks that must complete first |
| `blocks` | string[] | IDs of tasks this one unblocks |
| `entireSessionId` | string | Session ID recorded during implementation |
| `notes` | string | Free-form agent notes |

---

## MCP Tools

### `sync_task`

Upsert a task by ID. Creates if not exists; updates all supplied fields if it does.
Used by `openspec-orchestrator` to sync requirements from the Living Spec to the hub.

**Input:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Stable task slug |
| `title` | string | ✓ | Task title |
| `status` | string | — | Defaults to `pending` on create; unchanged on update if omitted |
| `metadata` | object | — | Merged with existing metadata on update |

**Returns:** The full task record after write.

**Behaviour:**
- On create: sets `created_at` and `updated_at` to now
- On update: merges `metadata` (top-level keys only), updates `updated_at`
- Status is only changed if explicitly supplied

---

### `fetch_tasks`

Query tasks. All filters are optional — omitting all returns every task.

**Input:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | — | Return exactly this task |
| `status` | string | — | Filter by status (`pending`, `in-progress`, `completed`, `blocked`) |
| `change` | string | — | Filter by `metadata.change` value |

**Returns:** Array of task records, ordered by `priority` (P0 first) then `created_at` ascending.

**Behaviour:**
- Filters are ANDed; `change` filters on `metadata.change` post-query
- Returns empty array (not an error) when no tasks match
- `priority` sort order: `P0` → `P1` → `P2` → null

---

### `update_task_status`

Transition the status of an existing task. Lightweight alternative to `sync_task`
when only status needs to change.

**Input:**

| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | ✓ | Task to update |
| `status` | string | ✓ | New status value |

**Returns:** The full task record after write.

**Behaviour:**
- Errors if task ID does not exist
- Updates `updated_at`
- Does not touch `metadata`

---

## HTTP / Health Endpoints

The server also exposes plain HTTP endpoints for scripting and CI use.

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Returns `{"status":"ok","task_count":N}` |
| `/tasks` | GET | Returns all tasks as JSON array |
| `/tasks/<id>` | GET | Returns single task or 404 |

These are read-only convenience endpoints. All writes go through MCP tools.

---

## Transport

Default transport is **SSE** on `http://localhost:8000/sse`.

The port and host are configurable via environment variables:

| Var | Default | Description |
|-----|---------|-------------|
| `HUB_HOST` | `0.0.0.0` | Bind address |
| `HUB_PORT` | `8000` | Port |
| `HUB_DB_PATH` | `/data/hub.db` | SQLite file path (inside Docker container) |
| `HUB_LOG_LEVEL` | `INFO` | `DEBUG` · `INFO` · `WARNING` |

---

## Non-Functional Requirements

- **Zero repo footprint:** the server and its database live outside any project repo
- **Single process:** no daemon, no message queue — one Python process, one SQLite file
- **Startup time < 2s:** agents should not wait on the hub
- **Concurrent agents:** SSE supports multiple simultaneous agent connections
- **Idempotent writes:** calling `sync_task` twice with the same data produces the same state

---

## Out of Scope (v1)

- Authentication / API keys (trusted local network assumed)
- Multi-user / multi-project isolation (use separate hub instances per project)
- Task history / audit log
- Push notifications to agents (agents poll)

---

## Acceptance Criteria

- [x] `sync_task` creates a new task with correct fields
- [x] `sync_task` updates an existing task, merging metadata
- [x] `fetch_tasks(status="pending")` returns tasks in priority order
- [x] `fetch_tasks(id="x")` returns exactly that task or empty array
- [x] `update_task_status` transitions status and updates `updated_at`
- [x] `update_task_status` errors on unknown ID
- [x] `/health` returns 200 with task count
- [x] `/tasks` returns all tasks as JSON
- [x] `/tasks/<id>` returns a single task or 404
- [ ] Server starts in under 2 seconds
- [ ] Hub survives restart — tasks persist in SQLite
- [ ] Two agents connected simultaneously both see consistent state
- [x] Generated repo includes automated tests for store and HTTP routes
- [x] Setup workflow includes dependency install, build, and verification steps
- [x] Generated repo passes `python -m compileall .`
- [x] Generated repo passes `pytest`
- [x] Generated repo builds and starts successfully with `docker compose build` and `docker compose up -d`
- [x] Generated repo verifies `/health` and `/tasks` via HTTP after startup

---

## Dependencies

- Python 3.12+
- `mcp[cli]` — MCP server framework
- `starlette` + `uvicorn` — HTTP health/read endpoints
- `aiosqlite` — async SQLite driver
- `python-dotenv` — environment configuration
- No external services required
