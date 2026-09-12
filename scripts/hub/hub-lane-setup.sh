#!/usr/bin/env bash
# hub-lane-setup.sh <repo> <lane-number>
#
# Idempotently (re)create the git worktree a drain lane works in, reset it to
# main, and make it gate-ready: install deps from the pnpm store and copy the
# gitignored files the repo's tests/type-check need (env files, convex
# codegen). Prints "READY <worktree-path> <HEAD>" on success.
#
# Called by the hub-drain workflow through a steward agent; contains every git
# operation a lane needs at start so no LLM improvises them.
set -euo pipefail
REPO="${1:?repo path}"; N="${2:?lane number}"
BR="lane-$N"; WT="${REPO}-lanes/lane-$N"
mkdir -p "$(dirname "$WT")"

git -C "$REPO" worktree prune >/dev/null 2>&1 || true
if [ -d "$WT/.git" ] || [ -f "$WT/.git" ]; then
  git -C "$WT" checkout -q -B "$BR" main
  git -C "$WT" reset -q --hard main
  # drop stray tracked-file edits/untracked source from a dead worker, but keep
  # the ignored scaffolding we copy below and node_modules
  git -C "$WT" clean -fdq -e node_modules -e convex/_generated -e '.env.local' \
    -e 'frontend/.env.local' -e 'worker/.env.local' -e 'frontend/next-env.d.ts'
else
  git -C "$REPO" worktree add -q -B "$BR" "$WT" main
fi

# Gitignored inputs the gates need. Deploy/service secrets are deliberately NOT
# copied — workers never deploy (hub-worker hard rules).
for f in .env.local frontend/.env.local worker/.env.local frontend/next-env.d.ts; do
  if [ -e "$REPO/$f" ] && [ ! -e "$WT/$f" ]; then
    mkdir -p "$(dirname "$WT/$f")"; cp "$REPO/$f" "$WT/$f"
  fi
done
if [ -d "$REPO/convex/_generated" ]; then
  mkdir -p "$WT/convex/_generated"
  rsync -a --delete "$REPO/convex/_generated/" "$WT/convex/_generated/"
fi

# Regenerate the Convex API types for THIS checkout. convex/_generated is
# gitignored; a stale copy makes the frontend's `next build` type-check fail on
# any convex function another task added (2026-09-03: main drifted while every
# worktree hand-patched its own copy). `convex codegen` is local-only — it
# writes convex/_generated and never pushes — but the CLI insists on a
# deployment context, so pass the self-hosted one from deploy/omarchy/.env if
# it exists. Failure is non-fatal: workers can still hand-patch.
if [ -f "$REPO/deploy/omarchy/.env" ] && [ -d "$WT/convex" ]; then
  KEY="$(grep '^CONVEX_SELF_HOSTED_ADMIN_KEY=' "$REPO/deploy/omarchy/.env" | cut -d= -f2- || true)"
  URL="$(grep '^CONVEX_SELF_HOSTED_URL=' "$REPO/deploy/omarchy/.env" | cut -d= -f2- || true)"
  if [ -n "$KEY" ]; then
    (cd "$WT" && CONVEX_SELF_HOSTED_URL="${URL:-http://127.0.0.1:3210}" CONVEX_SELF_HOSTED_ADMIN_KEY="$KEY" \
      timeout 120 npx convex codegen >/dev/null 2>&1) || echo "codegen skipped (non-fatal)" >&2
  fi
fi

# Install only when the lockfile changed since the last install in this lane.
cd "$WT"
LOCK_HASH="$(sha256sum pnpm-lock.yaml | cut -c1-16)"
STAMP="node_modules/.hub-lane-lock"
if [ ! -d node_modules ] || [ "$(cat "$STAMP" 2>/dev/null || true)" != "$LOCK_HASH" ]; then
  pnpm install --frozen-lockfile --prefer-offline --silent >/dev/null 2>&1 \
    || pnpm install --frozen-lockfile --silent >/dev/null
  echo "$LOCK_HASH" > "$STAMP"
fi

echo "READY $WT $(git rev-parse --short HEAD)"
