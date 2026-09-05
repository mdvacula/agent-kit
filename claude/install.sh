#!/usr/bin/env bash
# Install the Claude Code generation of the agent-kit into ~/.claude.
# Manual, idempotent, copy-based (no symlinks, no automation) — run by hand
# after pulling this repo. Overwrites the installed copies with the repo's.
#
# Memory files are per-project and are NOT installed here — see install-memory.sh.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

mkdir -p "$DST/agents" "$DST/skills" "$DST/workflows" "$DST/scripts"

cp -v "$SRC"/agents/*.md "$DST/agents/"
for skill in "$SRC"/skills/*/; do
  name="$(basename "$skill")"
  mkdir -p "$DST/skills/$name"
  cp -v "$skill"SKILL.md "$DST/skills/$name/"
done
# workflows = the Workflow-tool scripts (.js) plus the shell/python helpers the
# drain calls by absolute path (hub-lane-*.sh, hub-queue.py)
cp -v "$SRC"/workflows/* "$DST/workflows/"
chmod +x "$DST"/workflows/*.sh
cp -v "$SRC"/scripts/*.py "$DST/scripts/"
chmod +x "$DST"/scripts/*.py

echo "Installed. New sessions pick these up automatically."
echo "Note: hub-drain.js resolves its helpers at \$SCRIPTS (default /home/mdv/.claude/workflows) — edit if your CLAUDE_CONFIG_DIR differs."
