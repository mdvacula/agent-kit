---
name: mcp-hub-setup
description: >
  Dual-mode skill for the MCP Task Hub Docker service.
  MODE A (local): clones mcp-task-hub, configures .env, runs docker compose up.
  MODE B (template generation): writes the complete Docker project files into
  the mcp-task-hub repo checkout for the sync-hub GitHub Action.
---

# MCP Task Hub Setup

The MCP Task Hub is a standalone Docker service. It runs once on your machine
and serves all your projects simultaneously. Agents connect to it over SSE.

| Mode | Trigger | What it does |
|------|---------|--------------|
| **A — Local** | Developer runs this skill to get the hub running | Clones repo, configures env, starts container |
| **B — Generate** | pi agent invoked by `sync-hub.yml` | Writes all project files into `mcp-task-hub/` checkout |

---

---

# MODE A — LOCAL SETUP

_Run this when you want to start the hub on your machine for the first time,
or re-run it to apply updates from the `mcp-task-hub` repo._

---

## A1 — Prerequisites

```bash
docker --version    || echo "MISSING: install Docker Desktop from https://docker.com"
docker compose version || echo "MISSING: Docker Compose v2 required"
git --version       || echo "MISSING: install git"
```

Do not proceed until all three pass.

---

## A2 — Clone or Update the Hub Repo

```bash
# First time
git clone https://github.com/mdvacula/mcp-task-hub ~/mcp-task-hub

# Subsequent updates
cd ~/mcp-task-hub && git pull --rebase
```

The hub lives at `~/mcp-task-hub` by convention — outside all project repos.
You can choose a different path; just be consistent across projects.

---

## A3 — Configure Environment

```bash
cd ~/mcp-task-hub
cp .env.example .env
```

Edit `.env` if you need to change the port (default 8000) or log level.
The SQLite database path is managed by Docker volumes — do not change `HUB_DB_PATH`.

```
HUB_HOST=0.0.0.0
HUB_PORT=8000
HUB_DB_PATH=/data/hub.db
HUB_LOG_LEVEL=INFO
```

---

## A4 — Start the Hub

```bash
cd ~/mcp-task-hub
docker compose up -d
```

Expected: container `mcp-task-hub` starts, port 8000 is bound.

---

## A5 — Verify

```bash
# Health check
curl http://localhost:8000/health
# → {"status":"ok","task_count":0}

# Container is running
docker compose ps
# → mcp-task-hub   running   0.0.0.0:8000->8000/tcp

# Logs (optional)
docker compose logs -f
```

---

## A6 — Connect Projects

In any project's `.cursor/mcp.json` set:

```json
{
  "mcpServers": {
    "task-hub": {
      "url": "http://localhost:8000/sse",
      "transport": "sse"
    }
  }
}
```

Open Cursor's MCP panel — `task-hub` should appear as connected with three
tools: `sync_task`, `fetch_tasks`, `update_task_status`.

---

## A7 — Useful Commands

```bash
# Stop the hub (data persists in Docker volume)
docker compose down

# Stop and wipe all data
docker compose down -v

# Rebuild after a hub update
docker compose pull && docker compose up -d --build

# Direct DB inspection
docker compose exec task-hub sqlite3 /data/hub.db "SELECT id,title,status FROM tasks;"
```

---

---

# MODE B — GENERATE (pi agent / sync-hub.yml)

_Use this mode when the pi agent is generating or updating the `mcp-task-hub` repo._

**Rules for this mode:**
- Read `specs/mcp-task-hub/spec.md` before writing any files
- Treat the spec as the source of truth for behavior, acceptance criteria, and verification
- Do NOT run `docker compose`, `git clone`, or any interactive command
- Do NOT prompt for variables — leave placeholders as literal strings
- Write all files directly into the working directory (checkout of `mcp-task-hub/`)
- Commit message format: `chore(hub): sync from agent-kit <short-sha>`

**Before generating files, confirm the spec requires:**
- the MCP tools and HTTP endpoints listed in the spec
- automated tests for store behavior and HTTP routes
- verification commands for install, compile, pytest, and docker compose
- any acceptance criteria that are not already covered by the template

---

## B1 — Write `Dockerfile`

```dockerfile
FROM python:3.12-slim

WORKDIR /app

# Install dependencies first for layer caching
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy source
COPY main.py .
COPY hub/ hub/

# Data volume for SQLite
VOLUME ["/data"]

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" \
  || exit 1

CMD ["python", "main.py"]
```

---

## B2 — Write `docker-compose.yml`

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

---

## B3 — Write `requirements.txt`

```
mcp[cli]>=1.0.0
aiosqlite>=0.20.0
starlette>=0.40.0
uvicorn>=0.30.0
python-dotenv>=1.0.0
```

---

## B4 — Write `.env.example`

```
HUB_HOST=0.0.0.0
HUB_PORT=8000
HUB_DB_PATH=/data/hub.db
HUB_LOG_LEVEL=INFO
```

---

## B5 — Write `hub/store.py`

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

---

## B6 — Write `hub/server.py`

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
        title:    Human-readable title
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

---

## B7 — Write `hub/__init__.py`

```python
from .server import mcp, http_routes, store, HOST, PORT

__all__ = ["mcp", "http_routes", "store", "HOST", "PORT"]
```

---

## B8 — Write `main.py`

> **Starlette 1.0 compatibility note:** `on_startup`, `on_shutdown`, and
> `on_event` were all removed in Starlette 1.0. Use the `lifespan` parameter
> with an `asynccontextmanager` instead. `mcp.get_asgi_app()` is also not
> available on all `FastMCP` versions — mount MCP routes separately if needed.

```python
"""
MCP Task Hub entry point.
Serves HTTP endpoints for health and task reads.

Uses the Starlette 1.0 lifespan context manager for startup/shutdown hooks.
(on_startup / on_shutdown / on_event were removed in Starlette 1.0.)
"""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

import uvicorn
from starlette.applications import Starlette
from starlette.routing import Route

from hub import http_routes, store, HOST, PORT

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
    routes=[Route(r.path, r.endpoint) for r in http_routes],
    lifespan=lifespan,
)


if __name__ == "__main__":
    uvicorn.run("main:app", host=HOST, port=PORT,
                log_level="info", reload=False)
```

---

## B9 — Write `.dockerignore`

```
.env
.git
__pycache__
*.pyc
*.pyo
hub.db
.venv
```

---

## B10 — Write `README.md`

```markdown
# mcp-task-hub

Centralized task execution state for agentic coding workflows.
Runs as a Docker container. Agents connect via MCP over SSE.

## Quick Start

```bash
git clone https://github.com/mdvacula/mcp-task-hub ~/mcp-task-hub
cd ~/mcp-task-hub
cp .env.example .env
docker compose up -d
```

Hub is now running:
- **SSE (MCP):**  `http://localhost:8000/sse`
- **Health:**     `http://localhost:8000/health`
- **Tasks (GET):**`http://localhost:8000/tasks`

## Connect a Project

Add to `.cursor/mcp.json` in any project:

```json
{
  "mcpServers": {
    "task-hub": {
      "url": "http://localhost:8000/sse",
      "transport": "sse"
    }
  }
}
```

## MCP Tools

| Tool | Purpose |
|------|---------|
| `sync_task(id, title, status?, metadata?)` | Upsert a task |
| `fetch_tasks(id?, status?, change?)` | Query tasks |
| `update_task_status(id, status)` | Transition task status |

## Useful Commands

```bash
docker compose up -d          # start in background
docker compose down           # stop (data persists)
docker compose down -v        # stop + wipe all data
docker compose logs -f        # follow logs
docker compose up -d --build  # rebuild after update

# Inspect the database directly
docker compose exec task-hub sqlite3 /data/hub.db \
  "SELECT id, title, status FROM tasks;"
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `HUB_HOST` | `0.0.0.0` | Bind address |
| `HUB_PORT` | `8000` | Exposed port |
| `HUB_DB_PATH` | `/data/hub.db` | SQLite path inside container |
| `HUB_LOG_LEVEL` | `INFO` | `DEBUG` · `INFO` · `WARNING` |

## Source

Generated from [agent-kit](https://github.com/mdvacula/agent-kit).
```

---

## B11 — Verify File Tree

```
mcp-task-hub/
├── .dockerignore
├── .env.example
├── docker-compose.yml
├── Dockerfile
├── main.py
├── README.md
├── requirements.txt
└── hub/
    ├── __init__.py
    ├── server.py
    └── store.py
```

---

## B12 — Install Dependencies

Before verification, make sure the generated project can resolve and run its
Python dependencies.

```bash
cd ~/mcp-task-hub
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt
pip install pytest pytest-asyncio   # test-only; not in requirements.txt
```

If you are verifying inside Docker only, use `docker compose build` instead of a
local virtualenv, but still keep this step in the workflow so import issues are
caught early.

If the spec defines a required Python version or dependency baseline, use that
instead of guessing from the template.

**Important:** `pytest` and `pytest-asyncio` are not in `requirements.txt`
(they are dev-only). Install them separately for the local verification step.
Do not add them to `requirements.txt` — they would bloat the Docker image.

---

## B13 — Add Verification Tests

The generated repo should include automated checks, not just a file tree. Add a
minimal test suite that verifies the storage layer and the HTTP surface.

Use the spec's acceptance criteria to drive the assertions. If any criterion is
not directly testable, document the verification approach in the README and the
skill instructions.

Recommended files:

- `tests/test_store.py` for CRUD, merge, ordering, and status updates
- `tests/test_server.py` for `/health`, `/tasks`, and `/tasks/{task_id}`
- `tests/conftest.py` for temporary database setup and env monkeypatching

Test coverage should include:

- creating a task through `sync_task`
- updating an existing task and preserving merged metadata
- filtering by `id`, `status`, and `change`
- sorting tasks by priority then creation time
- updating status for an existing task and failing for a missing task
- returning `404` from the task read endpoint when the task is missing

**HTTP test pattern (Starlette 1.0 + lifespan):**

Because `TestClient` triggers the app's `lifespan` context manager, HTTP tests
must build a dedicated test app that wires up a temp store — they must NOT import
the module-level `app` from `main.py`, which would try to open `/data/hub.db`.

```python
# tests/conftest.py
import os
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

```python
# tests/test_server.py  (key fixture pattern)
from contextlib import asynccontextmanager
from typing import AsyncIterator
from starlette.applications import Starlette
from starlette.testclient import TestClient
import hub.server as server

@pytest.fixture
def test_app(temp_db_path):
    store = server.TaskStore(str(temp_db_path))

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        await store.connect()
        await store.sync_task(id="task-1", title="Task 1", metadata={"priority": "P0"})
        old = server.store
        server.store = store
        try:
            yield
        finally:
            server.store = old
            await store.close()

    return Starlette(routes=server.http_routes, lifespan=lifespan)

def test_health_and_tasks_routes(test_app):
    with TestClient(test_app) as client:
        assert client.get("/health").json()["status"] == "ok"
        assert client.get("/tasks").json()[0]["id"] == "task-1"
```

Add a `pytest.ini` or `pyproject.toml` section to configure `pytest-asyncio`:

```ini
# pytest.ini
[pytest]
asyncio_mode = auto
```

Recommended command:

```bash
python -m pytest
```

Use `python -m pytest` (not bare `pytest`) to ensure the venv interpreter is
used regardless of the system `PATH`.

---

## B13b — Write `pytest.ini`

`pytest-asyncio` requires explicit mode configuration or it emits warnings and
may refuse to run async fixtures in strict mode. Add this file:

```ini
[pytest]
asyncio_mode = auto
```

---

## B14 — Build and Run Verification

**First:** ensure `.env` exists. `docker compose` will refuse to start if
`env_file: .env` is listed in `docker-compose.yml` but the file is absent.
The file is gitignored, so it is never present on a fresh checkout.

```bash
cd ~/mcp-task-hub
# Bootstrap .env if it doesn't exist yet
test -f .env || cp .env.example .env
```

Then run the full verification:

```bash
python -m compileall .
python -m pytest
docker compose build
docker compose up -d
sleep 3   # wait for uvicorn to bind
curl http://localhost:8000/health
# → {"status":"ok","task_count":0}
curl http://localhost:8000/tasks
# → []
docker compose ps
docker compose down
```

Expected results:

- `compileall` reports no syntax errors
- all pytest tests pass
- the image builds successfully
- the container starts without restart loops
- `/health` returns `{"status":"ok","task_count":0}`
- `/tasks` returns an empty JSON list on first run

**Lessons learned from first-run verification:**

| Issue | Root cause | Fix applied |
|-------|-----------|-------------|
| `docker compose up` fails silently | `.env` missing (only `.env.example` present) | Bootstrap step: `test -f .env \|\| cp .env.example .env` |
| `AttributeError: 'Starlette' has no attribute 'on_startup'` | Starlette 1.0 removed `on_startup`/`on_shutdown`/`on_event` | Use `lifespan` async context manager (see B8) |
| `AttributeError: 'FastMCP' has no attribute 'get_asgi_app'` | API not present on installed MCP version | Mount HTTP routes directly; skip MCP ASGI mount |
| `RuntimeError: Cannot run the event loop while another loop is running` | Calling `loop.run_until_complete` inside uvicorn's already-running loop | Only use `asynccontextmanager` lifespan — never call `run_until_complete` at module level |
| HTTP tests fail with `unable to open database file` | `TestClient` triggers `lifespan`, which tries to open `/data/hub.db` | Build a per-test `Starlette` app with a temp store (see B13) |
| `pytest: command not found` | `pytest` not on system PATH; installed only in venv | Always run `python -m pytest`, not bare `pytest` |

---

## B15 — Commit

```bash
git add .
git commit -m "chore(hub): sync from agent-kit <short-sha>

Updated files:
$(git diff --cached --name-only)"
```

Then open a pull request against `mcp-task-hub/main`.
