#!/usr/bin/env bash
# Install the OpenCode generation of the agent-kit into ~/.config/opencode.
# Manual, idempotent, copy-based (no symlinks, no automation) — run by hand
# after pulling this repo. Overwrites the installed copies with the repo's.
#
#   ./opencode/install.sh            # agents, commands, skills, hub scripts
#   ./opencode/install.sh --mcp      # ...and merge the task-hub MCP entry (+ CLAUDE.md
#                                    # instructions, task-hub permissions) into the
#                                    # global ~/.config/opencode/opencode.json
#
# Per-project alternative to --mcp: copy opencode/opencode.json into the repo
# root (OpenCode merges project config over global).
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(dirname "$SRC")"
DST="${OPENCODE_CONFIG_DIR:-$HOME/.config/opencode}"

mkdir -p "$DST/agents" "$DST/commands" "$DST/skills" "$DST/scripts/hub"

cp -v "$SRC"/agents/*.md "$DST/agents/"
cp -v "$SRC"/commands/*.md "$DST/commands/"
for skill in "$SRC"/skills/*/; do
  name="$(basename "$skill")"
  mkdir -p "$DST/skills/$name"
  cp -v "$skill"SKILL.md "$DST/skills/$name/"
done
# the same lane/queue/cli scripts the Claude Code drain uses (tool-agnostic)
cp -vL "$KIT"/scripts/hub/* "$DST/scripts/hub/"
chmod +x "$DST"/scripts/hub/*.sh "$DST"/scripts/hub/*.py

if [ "${1:-}" = "--mcp" ]; then
  python3 - "$DST/opencode.json" "$SRC/opencode.json" <<'PY'
import json, sys, pathlib
dst, src = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
cfg = json.loads(dst.read_text()) if dst.is_file() else {}
ref = json.loads(src.read_text())
cfg.setdefault("$schema", ref["$schema"])
cfg.setdefault("mcp", {})["task-hub"] = ref["mcp"]["task-hub"]
ins = cfg.setdefault("instructions", [])
for i in ref["instructions"]:
    if i not in ins: ins.append(i)
cfg.setdefault("permission", {}).update(ref["permission"])
dst.write_text(json.dumps(cfg, indent=2) + "\n")
print(f"merged task-hub MCP entry into {dst}")
PY
fi

echo "Installed. Restart OpenCode (or open a new session) to pick these up."
echo "Hub must be running: curl http://127.0.0.1:8050/health"
