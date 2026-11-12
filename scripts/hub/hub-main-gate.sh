#!/usr/bin/env bash
# hub-main-gate.sh <repo> <old-main-sha> — the "main gate".
#
# Runs on the main checkout (on its base branch — .hub-base-branch, default
# main) after a lane has been fast-forwarded onto it and BEFORE the push.
# Exit 0 = green, 5 = red (stdout carries "MAIN-GATE FAILED: <check>" and the
# failing check's tail; the last line of a green run is "MAIN-GATE OK a..b").
# The caller (hub-lane-merge.sh) resets the branch to <old-main-sha> on red,
# so it never carries an unpushed red commit and the lane's work is parked
# for a fix cycle.
#
# Which checks run is resolved per repo (same convention as .hub-base-branch:
# the repo owns its gate, this script owns only the contract):
#   1. <repo>/.hub-main-gate.sh exists → run it (bash, cwd = repo) with
#      HUB_GATE_OLD, HUB_GATE_NEW and HUB_GATE_CHANGED (newline-separated
#      `git diff --name-only old..HEAD`) in the environment; nonzero = red.
#   2. else a beatpath-shaped tree (packages/shared + frontend + convex) →
#      the original beatpath checks, unchanged.
#   3. else the generic pnpm fallback: whichever of the package.json scripts
#      type-check, type-check:scripts, lint, test exist, in that order (CI=1
#      so a watch-mode test runner exits).
# The lockfile-changed `pnpm install` runs before all three, and so does
# hub-diff-guards.py in warn-only mode.
#
# Why the resolution: until 2026-10-20 the beatpath checks ran for every repo,
# and the newjerseybrews drain that day had five PASS reviews and zero
# landings — every land died at `pnpm -C packages/shared build` (ENOENT: no
# packages/ in that repo), the branch was reset and the lanes parked.
#
# Why the beatpath checks exist: six landings on 2026-09-29/30 were green in
# their lane and red on main, every one for a reason a lane's own gates
# cannot see:
#   - the convex/ tsconfig is not in `turbo run type-check` (until 2026-09-30);
#   - packages/llm-shared's coverage guards scan the WHOLE tree, so a landing
#     that touches a call site elsewhere breaks them while its own suites pass;
#   - a lane that adds a dependency leaves the main checkout uninstalled;
#   - lint baselines (catalog-write-baseline.json) drift across changes;
#   - test-file typing errors surface only against the rebased base.
set -uo pipefail
REPO="${1:?repo path}"; OLD="${2:?old main sha}"
cd "$REPO"
NEW="$(git rev-parse --short HEAD)"
CHANGED="$(git diff --name-only "$OLD..HEAD" || true)"
LOG="$(mktemp)"
fail() { echo "MAIN-GATE FAILED: $1"; tail -n 25 "$LOG"; rm -f "$LOG"; exit 5; }
step() { echo "── main-gate: $1"; }

# HUB_GATE_DRY_RUN=1: print the resolved branch and its checks, run nothing
# (not even the install), exit 0. For validating the resolution on a lane.
DRY="${HUB_GATE_DRY_RUN:-0}"
has_script() { node -e 'process.exit(require("./package.json").scripts?.[process.argv[1]] ? 0 : 1)' "$1" 2>/dev/null; }
if [ "$DRY" = 1 ]; then
  echo "$CHANGED" | grep -q '^pnpm-lock.yaml$' && echo "── main-gate (dry): pnpm install (lockfile changed)"
  if [ -f "$REPO/.hub-main-gate.sh" ]; then
    echo "── main-gate (dry): branch A — repo .hub-main-gate.sh with HUB_GATE_OLD=$OLD HUB_GATE_NEW=$NEW HUB_GATE_CHANGED=<$(echo "$CHANGED" | grep -c .) paths>"
  elif [ -d packages/shared ] && [ -d frontend ] && [ -d convex ]; then
    echo "── main-gate (dry): branch B — beatpath checks: packages/shared build, tsc frontend, tsc convex, tsc worker, pnpm lint$(echo "$CHANGED" | grep -qE '^(worker/src/|convex/|packages/llm-shared/)' && echo ', llm-shared vitest')"
  else
    found=""; for s in type-check type-check:scripts lint test; do has_script "$s" && found="$found $s"; done
    echo "── main-gate (dry): branch C — generic pnpm scripts:${found:- (none)}"
  fi
  rm -f "$LOG"; echo "MAIN-GATE OK $OLD..$NEW (dry run)"; exit 0
fi

# Growth guards, warn only: the reviewer already fails a lane on these, so a
# line here means a landing got past review with one. It never turns the gate
# red; the lines land in the drain log for the owner to read.
GUARDS="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")/hub-diff-guards.py"
if [ -f "$GUARDS" ]; then
  step "diff guards (warn only)"
  python3 "$GUARDS" "$OLD..HEAD" --warn || true
fi

# 0. dependencies (every branch) — only when the lockfile moved (pnpm install is idempotent
#    but slow enough to skip otherwise).
if echo "$CHANGED" | grep -q '^pnpm-lock.yaml$'; then
  step "pnpm install (lockfile changed)"
  pnpm install --frozen-lockfile >"$LOG" 2>&1 || fail "pnpm install"
fi

# A. the repo's own gate, when it carries one.
if [ -f "$REPO/.hub-main-gate.sh" ]; then
  step "repo .hub-main-gate.sh"
  HUB_GATE_OLD="$OLD" HUB_GATE_NEW="$NEW" HUB_GATE_CHANGED="$CHANGED" \
    timeout 1800 bash "$REPO/.hub-main-gate.sh" >"$LOG" 2>&1
  rc=$?
  [ "$rc" -eq 0 ] || fail "repo .hub-main-gate.sh (exit $rc)"
  rm -f "$LOG"
  echo "MAIN-GATE OK $OLD..$NEW"
  exit 0
fi

# B. beatpath-shaped tree: the original checks (their own 1–4), unchanged.
if [ -d packages/shared ] && [ -d frontend ] && [ -d convex ]; then
  # 1. shared dist — worker tsc resolves @beatpath/shared through it.
  step "packages/shared build"
  pnpm -C packages/shared build >"$LOG" 2>&1 || fail "packages/shared build"

  # 2. the three typechecks that matter, convex included (run from frontend/ so
  #    the convex tsconfig's ../frontend/node_modules paths resolve).
  step "tsc frontend"
  (cd frontend && npx tsc --noEmit -p .) >"$LOG" 2>&1 || fail "frontend tsc"
  step "tsc convex"
  (cd frontend && npx tsc --noEmit -p ../convex) >"$LOG" 2>&1 || fail "convex tsc"
  step "tsc worker"
  (cd worker && npx tsc --noEmit) >"$LOG" 2>&1 || fail "worker tsc"

  # 3. repo lint — the custom guards (full scans, catalog writes, generated
  #    surfaces) are fast; turbo lint is cached.
  step "pnpm lint"
  timeout 600 pnpm lint >"$LOG" 2>&1 || fail "pnpm lint"

  # 4. tree-wide guards: llm-shared's coverage suites scan every call site in
  #    worker/ and convex/, so run them whenever the range touched either (or
  #    the package itself).
  if echo "$CHANGED" | grep -qE '^(worker/src/|convex/|packages/llm-shared/)'; then
    step "llm-shared suite (tree-wide coverage guards)"
    (cd packages/llm-shared && npx vitest run) >"$LOG" 2>&1 || fail "llm-shared vitest"
  fi
  rm -f "$LOG"
  echo "MAIN-GATE OK $OLD..$NEW"
  exit 0
fi

# C. generic pnpm fallback: the package.json scripts that exist, in order.
ran=0
for s in type-check type-check:scripts lint test; do
  if has_script "$s"; then
    step "pnpm run $s"
    CI=1 timeout 900 pnpm run "$s" >"$LOG" 2>&1 || fail "pnpm run $s"
    ran=1
  fi
done
[ "$ran" -eq 1 ] || step "no type-check/type-check:scripts/lint/test script in package.json — nothing to run"

rm -f "$LOG"
echo "MAIN-GATE OK $OLD..$NEW"
exit 0
