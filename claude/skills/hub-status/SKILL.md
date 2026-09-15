---
name: hub-status
description: Show the MCP Task Hub queue — counts, blocked tasks with reasons, stale claims — grouped by project and change. Use when the user asks "hub status", "what's in the queue", "any blocked tasks", or after a drain run. The browser view is http://taskhub.local/ui (LAN).
---

# hub-status — queue overview

Fast path: `python3 ~/.claude/scripts/hub-cli.py status` prints hub health,
per-project status counts, and blocked tasks with reasons in one shot — start
there, then drill into specifics below if needed.

1. `curl -s http://127.0.0.1:8050/health` — if this fails, say so and check
   `docker ps` for the `task-hub` container (do NOT restart it without asking).
2. `curl -s http://127.0.0.1:8050/tasks` and summarize:
   - Counts by status, grouped project → change.
   - **Blocked tasks**: list each with the latest `metadata.statusNotes` entry
     (the reason) — these need user decisions.
   - **In review**: `in-review` = a worker committed in its lane; review,
     fix cycles or landing are still ahead. `completed` means landed on main.
   - **Stale claims**: `in-progress` or `in-review` with `updated_at` older
     than ~2 hours is probably an orphaned claim from a dead run. Offer (don't auto-do) a reset:
     `mcp__task-hub__update_task_status(id, "pending", notes="reset stale claim")`.
   - Recent `runLog` activity for anything currently draining.
3. Remind: the live view is `http://taskhub.local/ui` from any LAN browser;
   `/ui/#metrics` has per-change benchmarks (pass-first rate, fix cycles,
   graft adoption, median reads/tokens/lead time) and
   `python3 ~/.claude/workflows/measure-drain.py --project <p> [--since D]`
   gives the same per agent run from the transcripts.

Keep the output compact — a table for counts, prose for blocked reasons.
