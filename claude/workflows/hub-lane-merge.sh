#!/usr/bin/env bash
# hub-lane-merge.sh <repo> <lane-number>
#
# Land a lane's reviewed commits on main: rebase the lane branch onto main,
# fast-forward main to it, push. Exits 2 on a rebase conflict (aborted, lane
# left as it was), 3 if the main checkout is dirty, 4 if push keeps failing.
# Prints "MERGED <old-main>..<new-main>" on success. The workflow serialises
# calls to this script across lanes; it never runs concurrently with itself.
set -euo pipefail
REPO="${1:?repo path}"; N="${2:?lane number}"
BR="lane-$N"; WT="${REPO}-lanes/lane-$N"

if [ -n "$(git -C "$REPO" status --porcelain | grep -v '^??' || true)" ]; then
  echo "DIRTY main checkout has tracked modifications; refusing to merge" >&2; exit 3
fi

OLD="$(git -C "$REPO" rev-parse --short main)"
# A worker's stray UNTRACKED files (scratch copies, generated fixtures) make
# `git rebase` refuse to check out main ("would be overwritten") — that is not
# a conflict, and everything the task delivers is already committed. Drop
# them, keeping the ignored scaffolding the setup script maintains.
git -C "$WT" clean -fdq -e node_modules -e convex/_generated -e '.env.local' \
  -e 'frontend/.env.local' -e 'worker/.env.local' -e 'frontend/next-env.d.ts' >/dev/null 2>&1 || true
if ! git -C "$WT" rebase -q main >/dev/null 2>&1; then
  git -C "$WT" rebase --abort >/dev/null 2>&1 || true
  echo "CONFLICT rebasing $BR onto main; aborted, lane left intact" >&2; exit 2
fi
git -C "$REPO" merge -q --ff-only "$BR"

# Keep main's gitignored convex/_generated current with what just landed, so a
# build on the main checkout (and the frontend Docker build context, which
# copies convex/ from disk) does not fail on a function some lane added.
if [ -f "$REPO/deploy/omarchy/.env" ] && [ -d "$REPO/convex" ]; then
  KEY="$(grep '^CONVEX_SELF_HOSTED_ADMIN_KEY=' "$REPO/deploy/omarchy/.env" | cut -d= -f2- || true)"
  URL="$(grep '^CONVEX_SELF_HOSTED_URL=' "$REPO/deploy/omarchy/.env" | cut -d= -f2- || true)"
  if [ -n "$KEY" ]; then
    (cd "$REPO" && CONVEX_SELF_HOSTED_URL="${URL:-http://127.0.0.1:3210}" CONVEX_SELF_HOSTED_ADMIN_KEY="$KEY" \
      timeout 120 npx convex codegen >/dev/null 2>&1) || echo "codegen on main skipped (non-fatal)" >&2
  fi
fi

for attempt in 1 2 3; do
  if git -C "$REPO" push -q origin main; then
    echo "MERGED $OLD..$(git -C "$REPO" rev-parse --short main)"; exit 0
  fi
  git -C "$REPO" pull -q --rebase origin main || { echo "PUSH-REBASE failed" >&2; exit 4; }
  # keep the lane branch aligned with the rebased main
  git -C "$WT" reset -q --hard main
done
echo "PUSH failed after 3 attempts" >&2; exit 4
