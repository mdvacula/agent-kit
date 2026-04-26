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

Transition the status of an existing task.

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

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Returns `{"status":"ok","task_count":N}` |
| `/tasks` | GET | Returns all tasks as JSON array |
| `/tasks/<id>` | GET | Returns single task or 404 |

These are read-only convenience endpoints. All writes go through MCP tools.

---

## Transport

Default transport is **SSE** on `http://localhost:8000/sse`.

`mcp.sse_app()` is mounted at `"/"` in the Starlette app — **not** at `"/sse"`.
It registers its own `/sse` and `/messages/` routes internally. Mounting at
`"/sse"` doubles the path to `/sse/sse` and causes 404s on all MCP connections.
HTTP routes must be listed before `Mount("/", ...)` so they take precedence.

| Var | Default | Description |
|-----|---------|-------------|
| `HUB_HOST` | `0.0.0.0` | Bind address |
| `HUB_PORT` | `8000` | Port |
| `HUB_DB_PATH` | `/data/hub.db` | SQLite file path (inside Docker container) |
| `HUB_LOG_LEVEL` | `INFO` | `DEBUG` · `INFO` · `WARNING` |

---

## Implementation

The generator agent writes these files verbatim. Do not deviate without
updating this spec first.

### `Dockerfile`

```dockerfile
FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY hub/ hub/

VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" \
  || exit 1

CMD ["python", "main.py"]
```

### `docker-compose.yml`

```yaml
services:
  task-hub:
    build: .
    container_name: mcp-task-hub
    ports:
      - "${HUB_PORT:-8000}:8000"
    volumes:
      - hub-data:/data
    env_file:
      - .env
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "python", "-c",
             "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s

volumes:
  hub-data:
    driver: local
```

### `requirements.txt`

```
mcp[cli]>=1.0.0
aiosqlite>=0.20.0
starlette>=0.40.0
uvicorn>=0.30.0
python-dotenv>=1.0.0
```

### `.env.example`

```
HUB_HOST=0.0.0.0
HUB_PORT=8000
HUB_DB_PATH=/data/hub.db
HUB_LOG_LEVEL=INFO
```

### `.dockerignore`

```
.env
.git
__pycache__
*.pyc
*.pyo
hub.db
.venv
```

### `pytest.ini`

```ini
[pytest]
asyncio_mode = auto
```

### `hub/store.py`

```python
"""
SQLite storage layer for the MCP Task Hub.
All reads and writes go through TaskStore.
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

import aiosqlite

log = logging.getLogger(__name__)

SCHEMA = """
CREATE TABLE IF NOT EXISTS tasks (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'pending',
    metadata    TEXT NOT NULL DEFAULT '{}',
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status   ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(json_extract(metadata, '$.priority'));
"""


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _priority_key(task: dict) -> tuple:
    p = task.get("metadata", {}).get("priority", "P9")
    return ({"P0": 0, "P1": 1, "P2": 2}.get(p, 9), task.get("created_at", ""))


class TaskStore:
    def __init__(self, db_path: str) -> None:
        self.db_path = db_path
        self._db: aiosqlite.Connection | None = None

    async def connect(self) -> None:
        self._db = await aiosqlite.connect(self.db_path)
        self._db.row_factory = aiosqlite.Row
        await self._db.executescript(SCHEMA)
        await self._db.commit()
        log.info("TaskStore connected: %s", self.db_path)

    async def close(self) -> None:
        if self._db:
            await self._db.close()

    def _row(self, row: aiosqlite.Row) -> dict:
        d = dict(row)
        d["metadata"] = json.loads(d.get("metadata") or "{}")
        return d

    async def sync_task(
        self,
        id: str,
        title: str,
        status: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> dict:
        now = _now()
        async with self._db.execute(
            "SELECT * FROM tasks WHERE id = ?", (id,)
        ) as cur:
            existing = await cur.fetchone()

        if existing is None:
            await self._db.execute(
                "INSERT INTO tasks (id,title,status,metadata,created_at,updated_at)"
                " VALUES (?,?,?,?,?,?)",
                (id, title, status or "pending", json.dumps(metadata or {}), now, now),
            )
            log.info("Created task %s", id)
        else:
            ex = self._row(existing)
            merged = {**ex["metadata"], **(metadata or {})}
            await self._db.execute(
                "UPDATE tasks SET title=?,status=?,metadata=?,updated_at=? WHERE id=?",
                (title, status if status is not None else ex["status"],
                 json.dumps(merged), now, id),
            )
            log.info("Updated task %s", id)

        await self._db.commit()
        return await self.get_task(id)

    async def fetch_tasks(
        self,
        id: str | None = None,
        status: str | None = None,
        change: str | None = None,
    ) -> list[dict]:
        q, p = "SELECT * FROM tasks WHERE 1=1", []
        if id:
            q += " AND id=?"; p.append(id)
        if status:
            q += " AND status=?"; p.append(status)
        async with self._db.execute(q, p) as cur:
            rows = await cur.fetchall()
        tasks = [self._row(r) for r in rows]
        if change:
            tasks = [t for t in tasks if t["metadata"].get("change") == change]
        tasks.sort(key=_priority_key)
        return tasks

    async def update_task_status(self, id: str, status: str) -> dict:
        async with self._db.execute(
            "SELECT id FROM tasks WHERE id=?", (id,)
        ) as cur:
            if not await cur.fetchone():
                raise ValueError(f"Task not found: {id}")
        await self._db.execute(
            "UPDATE tasks SET status=?,updated_at=? WHERE id=?",
            (status, _now(), id),
        )
        await self._db.commit()
        log.info("Status %s → %s", id, status)
        return await self.get_task(id)

    async def get_task(self, id: str) -> dict | None:
        async with self._db.execute(
            "SELECT * FROM tasks WHERE id=?", (id,)
        ) as cur:
            row = await cur.fetchone()
        return self._row(row) if row else None

    async def all_tasks(self) -> list[dict]:
        async with self._db.execute("SELECT * FROM tasks") as cur:
            rows = await cur.fetchall()
        return [self._row(r) for r in rows]

    async def task_count(self) -> int:
        async with self._db.execute("SELECT COUNT(*) FROM tasks") as cur:
            row = await cur.fetchone()
        return row[0] if row else 0
```

### `hub/server.py`

```python
"""
MCP Task Hub — tool definitions and HTTP health endpoints.
"""
from __future__ import annotations

import logging
import os
from typing import Any

from dotenv import load_dotenv
from mcp.server.fastmcp import FastMCP
from starlette.requests import Request
from starlette.responses import JSONResponse, Response
from starlette.routing import Route

from .store import TaskStore

load_dotenv()

log = logging.getLogger(__name__)

HOST      = os.getenv("HUB_HOST",      "0.0.0.0")
PORT      = int(os.getenv("HUB_PORT",  "8000"))
DB_PATH   = os.getenv("HUB_DB_PATH",   "/data/hub.db")
LOG_LEVEL = os.getenv("HUB_LOG_LEVEL", "INFO")

logging.basicConfig(level=getattr(logging, LOG_LEVEL))

store = TaskStore(DB_PATH)
mcp   = FastMCP("task-hub")


# ── MCP Tools ────────────────────────────────────────────────────────────────

@mcp.tool()
async def sync_task(
    id: str,
    title: str,
    status: str | None = None,
    metadata: dict[str, Any] | None = None,
) -> dict:
    """
    Upsert a task by ID.
    Creates with status 'pending' if new; merges metadata if existing.

    Args:
        id:       Stable kebab-case slug e.g. 'auth-implement-jwt'
        title:    Human-readable task title
        status:   pending | in-progress | completed | blocked
        metadata: Keys: change, specRef, priority, type,
                  blockedBy, blocks, entireSessionId, notes
    """
    return await store.sync_task(id=id, title=title,
                                 status=status, metadata=metadata)


@mcp.tool()
async def fetch_tasks(
    id: str | None = None,
    status: str | None = None,
    change: str | None = None,
) -> list[dict]:
    """
    Query tasks. Returns [] on no match — never errors on empty.
    Results ordered by priority (P0 first) then creation time.

    Args:
        id:     Exact task ID
        status: pending | in-progress | completed | blocked
        change: Filter by metadata.change (OpenSpec change ID)
    """
    return await store.fetch_tasks(id=id, status=status, change=change)


@mcp.tool()
async def update_task_status(id: str, status: str) -> dict:
    """
    Transition task status. Errors if ID does not exist.

    Args:
        id:     Task to update
        status: pending | in-progress | completed | blocked
    """
    return await store.update_task_status(id=id, status=status)


# ── HTTP read endpoints ───────────────────────────────────────────────────────

async def health(request: Request) -> JSONResponse:
    return JSONResponse({"status": "ok", "task_count": await store.task_count()})


async def list_tasks(request: Request) -> JSONResponse:
    return JSONResponse(await store.all_tasks())


async def get_task_endpoint(request: Request) -> Response:
    task = await store.get_task(request.path_params["task_id"])
    return JSONResponse(task) if task else JSONResponse({"error": "not found"}, status_code=404)


http_routes = [
    Route("/health",                 health),
    Route("/tasks",                  list_tasks),
    Route("/tasks/{task_id:str}",    get_task_endpoint),
]
```

### `hub/__init__.py`

```python
from .server import mcp, http_routes, store, HOST, PORT

__all__ = ["mcp", "http_routes", "store", "HOST", "PORT"]
```

### `main.py`

```python
"""
MCP Task Hub entry point.
Serves HTTP endpoints for health and task reads, and mounts the MCP transport.

Uses the Starlette 1.0 lifespan context manager for startup/shutdown hooks.
(on_startup / on_shutdown / on_event were removed in Starlette 1.0.)
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import uvicorn
from starlette.applications import Starlette
from starlette.routing import Mount, Route

from hub import HOST, PORT, http_routes, mcp, store

log = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: Starlette) -> AsyncIterator[None]:
    await store.connect()
    log.info("MCP Task Hub ready")
    log.info("Health → http://%s:%s/health", HOST, PORT)
    try:
        yield
    finally:
        await store.close()


app = Starlette(
    routes=[
        *[Route(r.path, r.endpoint) for r in http_routes],
        Mount("/", app=mcp.sse_app()),
    ],
    lifespan=lifespan,
)
# IMPORTANT: mcp.sse_app() is mounted at "/" not "/sse".
# It registers its own /sse and /messages/ routes internally.
# Mounting at "/sse" doubles the path to /sse/sse — causing 404s.
# HTTP routes are listed first so they take precedence.


if __name__ == "__main__":
    uvicorn.run("main:app", host=HOST, port=PORT,
                log_level="info", reload=False)
```

### `README.md`

See Transport section above for the connection config snippets to include.

---

## Tests

Tests live in `tests/`. The generator must produce all three files.

### `tests/conftest.py`

```python
import pytest


@pytest.fixture
def temp_db_path(tmp_path, monkeypatch):
    db_path = tmp_path / "hub.db"
    monkeypatch.setenv("HUB_DB_PATH", str(db_path))
    monkeypatch.setenv("HUB_HOST", "127.0.0.1")
    monkeypatch.setenv("HUB_PORT", "8000")
    monkeypatch.setenv("HUB_LOG_LEVEL", "INFO")
    return db_path
```

### `tests/test_server.py` (key fixture pattern)

HTTP tests must NOT import the module-level `app` from `main.py`.
Build a per-test Starlette app with a temp store:

```python
from contextlib import asynccontextmanager
from typing import AsyncIterator
import pytest
import hub.server as server
from hub.store import TaskStore
from starlette.applications import Starlette
from starlette.routing import Mount
from starlette.testclient import TestClient


@pytest.fixture
def test_app(temp_db_path):
    _store = TaskStore(str(temp_db_path))

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        await _store.connect()
        await _store.sync_task(id="task-1", title="Task 1", metadata={"priority": "P0"})
        old = server.store
        server.store = _store
        try:
            yield
        finally:
            server.store = old
            await _store.close()

    return Starlette(
        routes=[*server.http_routes, Mount("/", app=server.mcp.sse_app())],
        lifespan=lifespan,
    )
```

Cover: `/health`, `/tasks`, `/tasks/{id}`, 404 on missing task.

### `tests/test_store.py`

Cover: create, update, merge metadata, filter by id/status/change,
priority ordering, status transitions, error on missing ID.

---

## File Tree

```
mcp-task-hub/
├── .dockerignore
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── main.py
├── pytest.ini
├── README.md
├── requirements.txt
├── hub/
│   ├── __init__.py
│   ├── server.py
│   └── store.py
└── tests/
    ├── conftest.py
    ├── test_server.py
    └── test_store.py
```

---

## Verification

After generation, run:

```bash
test -f .env || cp .env.example .env
python -m compileall .
python -m pytest
docker compose build
docker compose up -d
sleep 3
curl http://localhost:8000/health
# → {"status":"ok","task_count":0}
curl --max-time 3 http://localhost:8000/sse
# → HTTP 200, content-type: text/event-stream
curl http://localhost:8000/tasks
# → []
docker compose down
```

All checks must pass before committing.

---

## Known Pitfalls

| Issue | Root cause | Fix |
|-------|-----------|-----|
| `/sse` returns 404 | `Mount("/sse", mcp.sse_app())` doubles the path | Mount at `"/"` not `"/sse"` |
| `docker compose up` fails silently | `.env` missing | `test -f .env \|\| cp .env.example .env` |
| `AttributeError: 'Starlette' has no attribute 'on_startup'` | Starlette 1.0 | Use `lifespan` asynccontextmanager |
| HTTP tests fail with `unable to open database file` | TestClient triggers lifespan | Build per-test Starlette app with temp store |
| `pytest: command not found` | Not on PATH | Always use `python -m pytest` |

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
- [x] `/sse` returns 200 with `content-type: text/event-stream`
- [ ] Server starts in under 2 seconds
- [ ] Hub survives restart — tasks persist in SQLite
- [ ] Two agents connected simultaneously both see consistent state
- [x] Generated repo includes automated tests for store and HTTP routes
- [x] Generated repo passes `python -m compileall .`
- [x] Generated repo passes `pytest`
- [x] Generated repo builds and starts with `docker compose build` and `docker compose up -d`
- [x] `/health`, `/tasks`, and `/sse` all verified after startup

---

## Dependencies

- Python 3.12+
- `mcp[cli]` — MCP server framework
- `starlette` + `uvicorn` — HTTP health/read endpoints + SSE transport
- `aiosqlite` — async SQLite driver
- `python-dotenv` — environment configuration
- No external services required
