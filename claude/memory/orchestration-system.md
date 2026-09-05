---
name: orchestration-system
description: "The Claude Code orchestration stack being built 2026-08 — task-hub MCP (127.0.0.1:8050), tiered hub-worker agents, opus hub-reviewer, /hub-drain workflow, shadcn UI"
metadata: 
  node_type: memory
  type: project
  originSessionId: 422e4dcb-51a5-4f79-beda-0665ef4f1d52
  modified: 2026-09-05T05:00:00.000Z
---

Built starting 2026-08-27 (plan: ~/.claude/plans/cheeky-exploring-meerkat.md). Successor to the opencode/pi generation (`mdvacula/agent-kit`, `mdvacula/mcp-task-hub` on GitHub; beatpath's `.claude/agents/hub-*` were the ported copies).

- **Hub**: `~/infra/task-hub` (clone of mdvacula/mcp-task-hub, push to main). Streamable HTTP at `127.0.0.1:8050/mcp` (old 8000 now = alpaca-bot dashboard — never reuse). `project` is a first-class column (repo dir name); `blocked` status requires notes; per-task `metadata.runLog` is the observability layer. UI at `/ui` (shadcn/React), exposed read-only as `taskhub.local` via gateway (`/mcp` never proxied).
- **Agents** (`~/.claude/agents/`): `hub-worker` (sonnet) + `-haiku`/`-opus` tier variants, `hub-reviewer` (opus, read-only, VERDICT PASS/FAIL). Workers NEVER push — review gates before push; checkpoint pushes by a git-steward step. Fix cycles: respawn fresh worker with findings, max 2, tier-bump on 2nd, then blocked + escalate to mdv.
- **Flow (end-to-end, one mandatory human gate)**: `/hub-spec {project, idea}` workflow (parallel explore → 3 lens approaches → opus judge → opus draft per repo OpenSpec schema → adversarial critics → 1 revise cycle; artifacts uncommitted) → ★ human reviews `openspec/changes/<id>/` → `/hub-plan` skill (reconciliation audit mandatory; chunk 3–8 checkboxes per hub task; tier rubric haiku/sonnet/opus; sync via steward Job D if session lacks hub MCP) → `/hub-drain` saved workflow (sequential v1; parallel worktrees later; escalates blockers to user) → `openspec-verify` + `/opsx:archive`.
- Fable 5 = planner/orchestrator in the main session only; drain returns early on blockers for user escalation (workflows can't prompt mid-run).
- Workflow `args` sometimes arrive as a STRING, not an object (bit two projects 2026-09). Both scripts have a `normalizeArgs()` shim (object / JSON / loose-literal). When launching via the Workflow tool, always pass args as a real JSON object; if editing/creating hub workflows, keep the shim.
- Pilot: newjerseybrews p2-2 map view (p1-3 enrichment is largely superseded by `scripts/research/` + sources.md rules — audit, don't run as written).

**Status 2026-08-27 (build session done):** hub deployed + registered user-wide, UI live (taskhub.local via gateway, /mcp blocked at nginx), agents/skills/workflow installed in `~/.claude` and mirrored to `mdvacula/agent-kit` `claude/` tree (pi sync Actions disabled), MCP tool layer smoke-tested via curl (all 3 tools incl. blocked-notes + project filter). NOT yet done: first agent-pipeline run — needs a session started after the MCP registration; then /hub-plan reconciliation audit of p1-3 and the p2-2 drain. `sudo ufw allow from 192.168.1.0/24 to any port 80 proto tcp` may still be pending for LAN access.

- **Hub UI spec viewer (2026-09-05, commit b2cb4b0):** the task sheet's Spec ref opens the OpenSpec markdown rendered in-hub (`GET /spec/{project}/{path}`, reads a read-only `/repos` mount = `~/code`; `openspec/**/*.md` only). Anchors written by `/hub-plan` are approximate (`#3`, paraphrases), so the viewer resolves them fuzzily; `node ui/scripts/check-spec-anchors.mts` audits them. The image was built but the container swap (`docker compose up -d` in `~/infra/task-hub`) was left for mdv because a beatpath drain was live — check `docker logs --since 15m task-hub | grep -c 'POST /mcp'` before swapping. Gateway `taskhub.conf` already proxies `/spec/` and `/specs`. Commit 540b4bb adds a **Specs screen** (`/ui/#specs`): every `openspec/changes/<id>/` on disk with proposal/design/tasks chips; **Pending review** = no hub task carries that change (the ★ gate between /hub-spec and /hub-plan) — pre-hub/abandoned changes show as pending too, so archive them.

**Status 2026-09-05:** the loop has run for real on beatpath + newjerseybrews (dozens of hub tasks, `metadata.runLog` populated). `/hub-drain` is now **parallel-lane**: one git worktree per lane under `<repo>-lanes/lane-N` (helpers `hub-lane-setup.sh` / `-park.sh` / `-merge.sh`, runnable set from `hub-queue.py`, all in `~/.claude/workflows/`); land = rebase onto main + ff-merge + push, serialised across lanes. `claude/scripts/hub-cli.py` is the plain-HTTP fallback for sessions without the hub MCP. Live copies in `~/.claude` are the source of truth; `mdvacula/agent-kit` `claude/` mirrors them (re-sync with `diff -rq` before committing there). This memory + the plan are backed up in agent-kit `claude/memory/` and `claude/plans/`; restore into any project's memory dir with `claude/install-memory.sh`.

Related: [[box-deployment-architecture]], [[no-headless-claude-automation]], [[agent-workflow-preferences]]
