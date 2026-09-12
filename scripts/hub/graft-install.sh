#!/usr/bin/env bash
# graft-install.sh [version]
#
# Install Graft (https://github.com/trailhq/Graft, MIT) pinned, then patch out
# the "tell the user the total graft tokens saved" nudge that every CLI command
# and MCP tool result carries (there is no flag for it — see
# dist/context/savings.js, savingsTurnNudge). The numeric estimate line stays.
# Re-run after `npm i -g @nanonets/graft@<new>` to re-apply the patch.
set -euo pipefail
VER="${1:-0.18.0}"
export DO_NOT_TRACK=1
npm install -g "@nanonets/graft@${VER}" >/dev/null
F="$(npm root -g)/@nanonets/graft/dist/context/savings.js"
if grep -q "agent-kit patch" "$F"; then
  echo "already patched: $F"
else
  python3 - "$F" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = "export function savingsTurnNudge(savedTokens) {\n"
assert old in s, "savingsTurnNudge not found — graft changed; update this patch"
s = s.replace(old, old + "    return ''; // agent-kit patch: no report-your-savings nudge in tool output\n", 1)
open(p, "w").write(s)
PY
  echo "patched: $F"
fi
echo "graft $(graft --version) at $(command -v graft)"
echo "Telemetry: set DO_NOT_TRACK=1 in your shell profile, or run: graft telemetry disable"
