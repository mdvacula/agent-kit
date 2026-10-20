# beatpath — landing-gate snippet

No file needed. beatpath's tree is beatpath-shaped (`packages/shared` +
`frontend` + `convex`), so `hub-main-gate.sh` runs the original checks
unchanged: `packages/shared` build, `tsc` for frontend / convex / worker,
`pnpm lint`, and the llm-shared suite when the range touched `worker/src/`,
`convex/` or `packages/llm-shared/`. Add `.hub-main-gate.sh` only if those
checks ever need to change — the repo hook then replaces them wholesale.

`.claude/**` needs no lint ignore: beatpath's lint is per package
(`turbo run lint`, eslint config in `frontend/`), so a workflow copy at
`.claude/workflows/hub-drain.js` is never linted.

## AGENTS.md — add under "Agent lane facts" (optional)

- **Landing gate:** after review passes, the drain fast-forwards your lane
  onto `main` and runs the box's main gate before the push: shared build,
  three `tsc` (frontend, convex, worker), `pnpm lint`, and the llm-shared
  coverage suite when the range touches `worker/src/`, `convex/` or
  `packages/llm-shared/`. Red resets `main` and parks your lane.
- **Lane hygiene:** `hub-lane-setup.sh` deletes `frontend/.next/types` (and
  `.next/dev/types`) on every lane reset; a fresh lane also needs
  `pnpm --filter @beatpath/shared build` before `pnpm --filter frontend build`.
