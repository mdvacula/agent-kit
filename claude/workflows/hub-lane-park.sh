#!/usr/bin/env bash
# hub-lane-park.sh <repo> <lane-number> <task-id>
#
# Preserve a lane's unmerged commits (a task that failed review or blocked with
# code we chose not to land) on a recoverable branch, then reset the lane to
# main so the next task starts clean. Prints "PARKED <branch> <sha>".
set -euo pipefail
REPO="${1:?repo path}"; N="${2:?lane number}"; TASK="${3:?task id}"
BR="lane-$N"; WT="${REPO}-lanes/lane-$N"
SAFE="$(echo "$TASK" | tr -c 'A-Za-z0-9._-' '-')"
PARK="parked/${SAFE}-$(date +%Y%m%d-%H%M)"
if [ "$(git -C "$WT" rev-parse HEAD)" != "$(git -C "$REPO" rev-parse main)" ]; then
  git -C "$WT" branch -f "$PARK" HEAD
  echo "PARKED $PARK $(git -C "$WT" rev-parse --short HEAD)"
else
  echo "PARKED none (lane already at main)"
fi
git -C "$WT" checkout -q -B "$BR" main
git -C "$WT" reset -q --hard main
