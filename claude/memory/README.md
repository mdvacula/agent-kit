# Orchestration memory (backup)

Claude Code auto-memory files for the agent-kit / task-hub orchestration work,
copied verbatim from `~/.claude/projects/-home-mdv/memory/` (origin session
`422e4dcb`, 2026-08-27 → 2026-09-05). They are what a planning session needs
to know that the code does not say: the loop's shape, the hub's address, the
owner's standing rules (official opsx only, no Entire, no agent-spawning
Actions, workers never deploy).

Restore into a project's memory dir (Claude Code keys memory by the directory
the session starts in): `./install-memory.sh ~/code` or `./install-memory.sh`
from inside the project. The plan-mode file that started the build is in
`../plans/orchestration-system-plan.md`.

When these change on the box, re-copy them here before committing; the live
files under `~/.claude` are the source of truth, this directory is the backup.
