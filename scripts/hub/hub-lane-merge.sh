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
# Rebase, auto-resolving the ONE generated file that conflicts whenever two
# changes both add Convex functions (packages/shared/src/convexFunctions.ts,
# emitted by scripts/genConvexFunctionNames.mjs). Six hand-landings on
# 2026-09-23 were exactly this. Any other conflicted file is a real conflict:
# abort and park as before. Bounded so a runaway rebase cannot loop forever.
GEN=packages/shared/src/convexFunctions.ts
if ! git -C "$WT" rebase -q main >/dev/null 2>&1; then
  for _step in 1 2 3 4 5 6 7 8 9 10; do
    CONF="$(git -C "$WT" diff --name-only --diff-filter=U || true)"
    if [ -z "$CONF" ]; then break; fi
    # Two auto-resolvable shapes; anything else is a real conflict.
    #  - the generated Convex function-name file: regenerate it.
    #  - an OpenSpec tasks.md where both sides only ticked checkboxes: keep
    #    the union of ticks (three PASS-reviewed tasks were parked for exactly
    #    this on 2026-09-24). The resolver refuses if the hunk is not
    #    checkbox-only, so a real edit conflict still aborts.
    RESOLVED_ALL=1
    for f in $CONF; do
      case "$f" in
        "$GEN")
          (cd "$WT" && node scripts/genConvexFunctionNames.mjs >/dev/null 2>&1) || RESOLVED_ALL=0 ;;
        openspec/changes/*/tasks.md)
          python3 "$(dirname "$0")/hub-tasks-union-ticks.py" "$WT/$f" --strict || RESOLVED_ALL=0 ;;
        *) RESOLVED_ALL=0 ;;
      esac
      [ "$RESOLVED_ALL" = 1 ] && git -C "$WT" add "$f"
    done
    if [ "$RESOLVED_ALL" != 1 ]; then
      git -C "$WT" rebase --abort >/dev/null 2>&1 || true
      echo "CONFLICT rebasing $BR onto main ($(echo "$CONF" | tr '\n' ' ')); aborted, lane left intact" >&2; exit 2
    fi
    if GIT_EDITOR=true git -C "$WT" rebase --continue >/dev/null 2>&1; then break; fi
  done
  if [ -d "$(git -C "$WT" rev-parse --git-path rebase-merge)" ] || [ -d "$(git -C "$WT" rev-parse --git-path rebase-apply)" ]; then
    git -C "$WT" rebase --abort >/dev/null 2>&1 || true
    echo "CONFLICT rebasing $BR onto main (unresolved after auto-regeneration); aborted, lane left intact" >&2; exit 2
  fi
  echo "note: auto-resolved generated/checkbox conflicts during rebase" >&2
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

# The main gate (hub-main-gate.sh): three typechecks incl. convex, lint, the
# tree-wide llm-shared guards, on MAIN as it will be pushed. Red = reset main
# to where it was, park the lane's commits, exit 5 so the drain records a
# blocked task with the failing check instead of a green "landed".
GATE="$(dirname "$0")/hub-main-gate.sh"
if [ -x "$GATE" ] && [ "${HUB_SKIP_MAIN_GATE:-0}" != 1 ]; then
  if ! GATE_OUT="$(bash "$GATE" "$REPO" "$OLD" 2>&1)"; then
    echo "$GATE_OUT" | tail -n 30 >&2
    NEWSHA="$(git -C "$REPO" rev-parse --short main)"
    git -C "$REPO" reset -q --hard "$OLD"
    echo "MAIN-GATE RED: main reset $NEWSHA -> $OLD; lane $BR still holds the rebased commits (park it)" >&2
    exit 5
  fi
  echo "$GATE_OUT" | tail -n 1 >&2
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
