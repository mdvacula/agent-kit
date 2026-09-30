#!/usr/bin/env bash
# hub-main-gate.sh <repo> <old-main-sha> — the "main gate".
#
# Runs on the MAIN checkout after a lane has been fast-forwarded onto it and
# BEFORE the push. Exists because six landings on 2026-09-29/30 were green in
# their lane and red on main, every one for a reason a lane's own gates cannot
# see:
#   - the convex/ tsconfig is not in `turbo run type-check` (until 2026-09-30);
#   - packages/llm-shared's coverage guards scan the WHOLE tree, so a landing
#     that touches a call site elsewhere breaks them while its own suites pass;
#   - a lane that adds a dependency leaves the main checkout uninstalled;
#   - lint baselines (catalog-write-baseline.json) drift across changes;
#   - test-file typing errors surface only against the rebased base.
# Exit 0 = green, 5 = red (stdout carries the failing check's tail). The caller
# (hub-lane-merge.sh) resets main to <old-main-sha> on 5, so main never carries
# an unpushed red commit and the lane's work is parked for a fix cycle.
set -uo pipefail
REPO="${1:?repo path}"; OLD="${2:?old main sha}"
cd "$REPO"
NEW="$(git rev-parse --short HEAD)"
CHANGED="$(git diff --name-only "$OLD..HEAD" || true)"
LOG="$(mktemp)"
fail() { echo "MAIN-GATE FAILED: $1"; tail -n 25 "$LOG"; rm -f "$LOG"; exit 5; }
step() { echo "── main-gate: $1"; }

# 0. dependencies — only when the lockfile moved (pnpm install is idempotent
#    but slow enough to skip otherwise).
if echo "$CHANGED" | grep -q '^pnpm-lock.yaml$'; then
  step "pnpm install (lockfile changed)"
  pnpm install --frozen-lockfile >"$LOG" 2>&1 || fail "pnpm install"
fi

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
