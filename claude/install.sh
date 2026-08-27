#!/usr/bin/env bash
# Install the Claude Code generation of the agent-kit into ~/.claude.
# Manual, idempotent, copy-based (no symlinks, no automation) — run by hand
# after pulling this repo. Overwrites the installed copies with the repo's.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DST="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"

mkdir -p "$DST/agents" "$DST/skills" "$DST/workflows"

cp -v "$SRC"/agents/*.md "$DST/agents/"
for skill in "$SRC"/skills/*/; do
  name="$(basename "$skill")"
  mkdir -p "$DST/skills/$name"
  cp -v "$skill"SKILL.md "$DST/skills/$name/"
done
cp -v "$SRC"/workflows/*.js "$DST/workflows/"

echo "Installed. New sessions pick these up automatically."
