---
name: mcp-hub-setup
description: >
  Dual-mode skill for the MCP Task Hub Docker service.
  MODE A (local): clones mcp-task-hub, configures .env, runs docker compose up.
  MODE B (template generation): reads specs/mcp-task-hub/spec.md and writes the
  complete Docker project files into the mcp-task-hub repo checkout for the
  sync-hub GitHub Action.
---

# MCP Task Hub Setup

The MCP Task Hub is a standalone Docker service. It runs once on your machine
and serves all your projects simultaneously. Agents connect to it over SSE.

| Mode | Trigger | What it does |
|------|---------|--------------|
| **A — Local** | Developer runs this skill to get the hub running | Clones repo, configures env, starts container |
| **B — Generate** | pi agent invoked by `sync-hub.yml` | Reads spec, writes all project files into `mcp-task-hub/` checkout |

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
git -C ~/mcp-task-hub pull --rebase
```

The hub lives at `~/mcp-task-hub` by convention — outside all project repos.

---

## A3 — Configure Environment

```bash
cd ~/mcp-task-hub
cp .env.example .env
```

Edit `.env` if you need to change the port (default 8000) or log level.
Do not change `HUB_DB_PATH` — it is managed by Docker volumes.

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
curl http://localhost:8000/health
# → {"status":"ok","task_count":0}

curl --max-time 3 http://localhost:8000/sse
# → HTTP 200, content-type: text/event-stream

docker compose ps
# → mcp-task-hub   running   0.0.0.0:8000->8000/tcp
```

---

## A6 — Connect Projects

For OpenCode, add to `opencode.json` in the project root:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "task-hub": {
      "type": "sse",
      "url": "http://localhost:8000/sse",
      "enabled": true
    }
  }
}
```

For Cursor, add to `.cursor/mcp.json`:

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

`task-hub` should appear as connected with three tools:
`sync_task`, `fetch_tasks`, `update_task_status`.

---

## A7 — Useful Commands

```bash
# Stop the hub (data persists in Docker volume)
docker compose down

# Stop and wipe all data
docker compose down -v

# Rebuild after a hub update
git -C ~/mcp-task-hub pull --rebase
docker compose -f ~/mcp-task-hub/docker-compose.yml up -d --build

# Direct DB inspection
docker compose exec task-hub sqlite3 /data/hub.db "SELECT id,title,status FROM tasks;"
```

---

# MODE B — GENERATE (pi agent / sync-hub.yml)

_Use this mode when the pi agent is generating or updating the `mcp-task-hub` repo._

**The spec is the source of truth. Read it first. Write exactly what it says.**

The canonical implementation — all file contents, the correct MCP mount pattern,
known pitfalls, and verification steps — lives in:

```
specs/mcp-task-hub/spec.md
```

This skill does not duplicate the implementation. The agent reads the spec and
writes the files. If the spec and this skill ever disagree, the spec wins.

---

## B1 — Read the Spec

Before writing any files:

```
Read: <agent-kit-source>/specs/mcp-task-hub/spec.md
```

Confirm the spec covers:
- All MCP tools (`sync_task`, `fetch_tasks`, `update_task_status`)
- HTTP endpoints (`/health`, `/tasks`, `/tasks/{id}`)
- Transport section — including the `Mount("/", mcp.sse_app())` requirement
- Implementation section — canonical file templates
- Tests section — `conftest.py`, `test_store.py`, `test_server.py` patterns
- Verification section — all commands that must pass
- Known Pitfalls section — especially the `/sse` mount path issue

---

## B2 — Write Files

Write every file listed in the spec's **File Tree** section verbatim into the
working directory (the `mcp-task-hub/` checkout).

Rules:
- Do NOT run `docker compose`, `git clone`, or any interactive command
- Do NOT prompt for variables — write files directly
- Do NOT invent implementation details not in the spec
- If the spec is ambiguous, use the most conservative interpretation

---

## B3 — Verify

Run the verification sequence from the spec's **Verification** section:

```bash
test -f .env || cp .env.example .env
python -m compileall .
python -m pytest
docker compose build
docker compose up -d
sleep 3
curl http://localhost:8000/health
curl --max-time 3 http://localhost:8000/sse
curl http://localhost:8000/tasks
docker compose down
```

All checks must pass before proceeding.

---

## B4 — Write PR Metadata

```bash
# Single-line title
echo "fix(hub): <what changed and why>" > /tmp/pr-title.txt

# Body
cat > /tmp/pr-body.md << 'EOF'
## What changed
- <bullet>

## Why
<1-2 sentences>

## Source
agent-kit commit: <short-sha>
EOF
```

---

## B5 — Commit

```bash
git add .
git commit -m "chore(hub): sync from agent-kit <short-sha>"
```

Then the workflow opens a pull request against `mcp-task-hub/main`.
