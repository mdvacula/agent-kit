#!/usr/bin/env bash
# hub-lane-park.sh <repo> <lane-number> <task-id>
#
# Preserve a lane's unmerged commits (a task that failed review or blocked with
# code we chose not to land) on a recoverable branch, then reset the lane to
# main so the next task starts clean. Prints "PARKED <branch> <sha>".
set -euo pipefail
REPO="${1:?repo path}"; N="${2:?lane number}"; TASK="${3:?task id}"
BR="lane-$N"; WT="${REPO}-lanes/lane-$N"
# Integration branch the lanes branch from and land on: the repo may pin it in
# a .hub-base-branch file (newjerseybrews: develop — main is the protected
# production branch, released by PR); default main.
BASE="$( (cat "$REPO/.hub-base-branch" 2>/dev/null || true) | tr -d "[:space:]")"; BASE="${BASE:-main}"  # wrapped: pipefail + absent file aborted the script (2026-10-18)
SAFE="$(echo "$TASK" | tr -c 'A-Za-z0-9._-' '-')"
PARK="parked/${SAFE}-$(date +%Y%m%d-%H%M)"
if [ "$(git -C "$WT" rev-parse HEAD)" != "$(git -C "$REPO" rev-parse "$BASE")" ]; then
  git -C "$WT" branch -f "$PARK" HEAD
  echo "PARKED $PARK $(git -C "$WT" rev-parse --short HEAD)"
else
  echo "PARKED none (lane already at main)"
fi
git -C "$WT" checkout -q -B "$BR" "$BASE"
git -C "$WT" reset -q --hard "$BASE"
