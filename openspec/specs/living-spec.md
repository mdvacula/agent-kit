# Living Spec — agent-kit

> Source of truth for requirements. Agents parse this file to sync tasks
> to the MCP Task Hub. Mark requirements complete here as work lands.
> This file IS tracked in Git.

---

## Capabilities

### MCP Task Hub

- [x] Hub exposes SSE transport at `http://localhost:8000/sse`
- [x] Hub exposes `/health`, `/tasks`, `/tasks/{id}` HTTP endpoints
- [x] `sync_task`, `fetch_tasks`, `update_task_status` MCP tools work
- [x] `specs/mcp-task-hub/spec.md` contains canonical implementation templates
- [x] `sync-hub.yml` regenerates `mcp-task-hub` on spec/skill changes
- [x] `mcp.sse_app()` mounted at `"/"` not `"/sse"` (avoids doubled path)
- [ ] Hub PR includes verification that `/sse` returns 200 in CI

### Agent Kit Structure

- [x] `specs/mcp-task-hub/spec.md` is source of truth for hub implementation
- [x] `.agents/skills/mcp-hub-setup/SKILL.md` references spec — no duplicated code
- [x] `specs/agent-kit/spec.md` documents this repo
- [x] `openspec/config.yaml` and `openspec/specs/living-spec.md` exist
- [x] `opencode.json` has correct MCP task-hub config with `type: "sse"`
- [ ] `sync-hub.yml` verifies `/sse` endpoint is live after container starts in CI

### OpenCode Integration

- [x] `opencode.json` connects to hub at `http://localhost:8000/sse`
- [ ] `/status` command works in all downstream projects
- [ ] `agentic-setup` skill produces valid `opencode.json` on first run

### Agent Workflow

- [x] `hub-runner` agent executes single tasks end-to-end
- [x] `hub-orchestrator` agent coordinates parallel task execution
- [x] `openspec-orchestrator` agent parses living spec and syncs tasks
- [ ] Git notes are attached after every task commit (`refs/notes/agent-log`)

---

## Maintenance

To update the hub:
1. Edit `specs/mcp-task-hub/spec.md`
2. Push to `main` — `sync-hub.yml` fires automatically
3. Review and merge the generated PR on `mcp-task-hub`
4. Run `git -C ~/mcp-task-hub pull --rebase && docker compose -f ~/mcp-task-hub/docker-compose.yml up -d --build`
