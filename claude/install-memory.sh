#!/usr/bin/env bash
# install-memory.sh [project-dir ...]
#
# Restore the orchestration memory files into Claude Code's auto-memory for one
# or more project directories (default: the current directory). Claude Code
# keys memory by the directory a session starts in:
#   ~/.claude/projects/<dir with / -> ->/memory/
# so a memory written from ~ is invisible to a session started from ~/code.
# Copies claude/memory/*.md into that directory and appends an index line to
# MEMORY.md for each file that is not already indexed. Idempotent.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/memory"
CFG="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

index_line() {
  case "$1" in
    orchestration-system.md)
      echo "- [Orchestration system](orchestration-system.md) — agent-kit + task-hub MCP (127.0.0.1:8050, taskhub.local UI) + tiered hub-worker/hub-reviewer agents + /hub-spec → /hub-plan → /hub-drain loop; backed up in agent-kit claude/memory" ;;
    agent-workflow-preferences.md)
      echo "- [Agent workflow preferences](agent-workflow-preferences.md) — opsx = official OpenSpec (always use); no Entire; agent-kit stays multi-tool; GH-Action agent builders disabled" ;;
    *)
      echo "- [${1%.md}](${1}) — (restored from agent-kit claude/memory)" ;;
  esac
}

for proj in "${@:-$PWD}"; do
  abs="$(cd "$proj" && pwd)"
  slug="$(echo "$abs" | tr '/' '-')"
  dst="$CFG/projects/$slug/memory"
  mkdir -p "$dst"
  touch "$dst/MEMORY.md"
  for f in "$SRC"/*.md; do
    name="$(basename "$f")"
    [ "$name" = "README.md" ] && continue
    cp "$f" "$dst/$name"
    grep -q "($name)" "$dst/MEMORY.md" || index_line "$name" >> "$dst/MEMORY.md"
  done
  echo "memory installed for $abs -> $dst"
done
