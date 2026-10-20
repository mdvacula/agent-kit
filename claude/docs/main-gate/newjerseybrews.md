# newjerseybrews — landing-gate snippet

`hub-main-gate.sh` resolves a repo hook first. newjerseybrews already carries
it (`.hub-main-gate.sh`, committed on `develop` in 8c5b238 — lint, type-check,
type-check:scripts when a `.mts` changed, `vitest run`; mirrors
`.github/workflows/ci.yml`). Reference copy of that file:

```bash
#!/usr/bin/env bash
# Repo-pinned "main gate" for hub-drain landings (read by the generic
# ~/.claude/workflows/hub-main-gate.sh, same convention as .hub-base-branch).
# Runs on the develop checkout after a lane is fast-forwarded and BEFORE the
# push; nonzero exit = red, the landing is reset and the lane parked.
# Mirrors .github/workflows/ci.yml exactly: lint, type-check, type-check:scripts,
# vitest. The environment carries HUB_GATE_OLD / HUB_GATE_NEW / HUB_GATE_CHANGED.
# (Added 2026-10-20 after the generic gate's beatpath-only step 1 parked five
# green reviews on the first newjerseybrews drain since it landed.)
set -euo pipefail
cd "$(dirname "$0")"
pnpm lint
pnpm type-check
if printf '%s\n' "${HUB_GATE_CHANGED:-}" | grep -q '\.mts$'; then pnpm type-check:scripts; fi
pnpm exec vitest run
```

Without the file the generic fallback would run the same four package
scripts (`type-check`, `type-check:scripts`, `lint`, `test`) unconditionally,
so deleting it degrades gracefully instead of parking every lane.

## eslint.config.mjs — add to `ignores`

The Workflow tool loads its script from inside the repo
(`.claude/workflows/hub-drain.js` by convention); `eslint .` must not lint it:

```js
      ".claude/**",
```

(next to `".next/**"` in the existing `ignores` array).

## AGENTS.md — add under "Agent lane facts"

- **Landing gate:** after review passes, the drain fast-forwards your lane
  onto `develop` and runs `.hub-main-gate.sh` (lint, type-check,
  type-check:scripts on `.mts` changes, vitest — the same as CI) before the
  push. Red resets `develop` and parks your lane, so the four gates you run
  in the lane are the ones that decide landing — run all of them.
- **Lane hygiene:** `hub-lane-setup.sh` deletes `.next/types` and
  `.next/dev/types` on every lane reset (stale route types from an older
  Next fail `pnpm type-check` with errors unrelated to your diff). If
  `pnpm type-check` reports errors only under `.next/`, delete those two
  directories and re-run — never "fix" generated types.
