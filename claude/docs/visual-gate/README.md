# The hub visual gate — design note (2026-10-20)

The visual gate is the lane-run half of visual acceptance: after a hub worker's
production build passes, `~/.claude/scripts/lane-visual.mjs` serves **that
lane's own** Next.js standalone build on a per-lane loopback port, loads each
route signed-out at iPhone 13 (390) and desktop (1440), checks the hard
invariants (horizontal overflow, route error boundary, page error, thin page,
no page inset at 390 — plus any repo-chosen ones such as an HTTP error
status), and writes `report.md` / `report.json` with fold + full JPEGs into
`openspec/changes/<change>/evidence/<task-id>/`. Exit 1 on a hard invariant,
2 when the probe cannot run. The worker commits the evidence; the Opus
reviewer opens every JPEG and treats missing evidence or a `FAIL` as a blocker.

It was written for beatpath (2026-10-14). This note records how it was made to
work for every repo on the box.

## Decision: a repo-root `.hub-visual.json`, with auto-detected defaults

Each repo that has a visual gate carries a tracked `.hub-visual.json` at its
root — the same convention as `.hub-base-branch` (a small file the shared
tooling reads from the lane's own checkout). The script stays the single
implementation of the probe and its invariants; the file only describes how
*this* repo's build is served and what its pages may talk to. Which paths
trigger the gate, which routes to probe per area, and where evidence goes are
prose in the repo's `AGENTS.md` "Visual gate" section (the agent rules point
there), because they are judgement for the worker, not data for the script.

### Options weighed

| Option | For | Against |
|---|---|---|
| **(a) `.hub-visual.json` + defaults** (chosen) | One probe, one set of invariants, one evidence contract for every repo; the file is versioned with the code it describes, reviewed in the repo's own diffs, and a lane reads its own copy; beatpath needs no change at all (a built-in profile reproduces today's behaviour byte-for-byte when no file exists). | The probe logic still lives outside each repo (mitigated by `delegate`, below). |
| (b) a shared Playwright spec run by each repo's `playwright.config` | Reuses device lists, SwiftShader args, `webServer`. | The configs are not built for this: newjerseybrews' `webServer` runs `pnpm dev` on :3000 (not the lane's standalone build, not a per-lane port); beatpath's lives in `tools/capture/` and carries the owner's session and a public-host guard — the suite a lane must never run. The spec would have to override nearly everything the config provides, and the report/JPEG contract would be re-derived from Playwright's reporter per repo. |
| (c) flags only | No new file. | Every worker would have to reproduce the env, host rules and port base on every call; the drift that broke the first beatpath runs (`HOSTNAME`, `CONVEX_URL`) would recur per lane. |

### `delegate` keeps beatpath's vendoring plan open

beatpath's open change `mobile-acceptance-automation` (design D2) plans to
vendor the probe into `tools/capture/lane-visual.mjs` and make the kit script a
shim. With this pattern that is one line in beatpath's config —
`"delegate": "tools/capture/lane-visual.mjs"` — and the kit script hands every
flag to the repo copy and returns its exit code. No other repo is affected.

## Config reference

All keys optional. Strings expand `{repo}` (the lane worktree), `{main}` (the
main checkout the worktree belongs to — where gitignored env files and large
data live), `{app}`, `{lane}`, `{port}`, and `${NAME:-default}` from the
environment. Unknown keys are refused (a typo must not silently fall back).

| Key | Default | Meaning |
|---|---|---|
| `delegate` | — | repo-relative path of a vendored probe to run instead |
| `appDir` | `frontend` if it has `.next`/`next.config.*`, else `.` | where the Next app's `.next` lives |
| `serverJs` | `server.js`, else `<appDir>/server.js` | server path inside `<appDir>/.next/standalone` |
| `portBase` | `3100` | port = `portBase + lane` (pick a distinct base per repo so two drains never collide) |
| `defaultRoutes` | `["/"]` | routes when `--routes` is omitted |
| `envFiles` | `[]` | dotenv files merged into the server env, later wins; missing files skipped |
| `env` | `{}` | server env applied last (override LAN URLs, blank DSNs) |
| `hostMappings` | `[]` | host names the browser resolves to 127.0.0.1 (bare names only) |
| `denyHosts` | `[]` | request hosts aborted and listed in the report (`*.example.com` ok) |
| `launchArgs` | `[]` | extra chromium args (SwiftShader for WebGL) |
| `playwrightFrom` | `["${LANE_VISUAL_CAPTURE_DIR:-}", "{repo}", "{app}", "{main}"]` | dirs to resolve `playwright` / `@playwright/test` from |
| `ignoreConsole` | `[]` | regexes; matching console errors are dropped |
| `errorBoundaryText` | beatpath's error copy | regexes; body text matching = route error boundary (fatal) |
| `minTextChars` | `200` | thin-page floor (fatal) |
| `minTextCharsByRoute` | `{}` | per-route floor keyed by path without query (a map-first page carries little text) |
| `failOnHttpStatus` | `null` | document status ≥ this is fatal |
| `settleMs` | `6000` | wait after `load` before measuring |

`node ~/.claude/scripts/lane-visual.mjs --repo <worktree> --print-config`
prints the resolved configuration.

**No config file + `frontend/` present** → the built-in beatpath profile (the
original hard-coded behaviour). **No config file otherwise** → the defaults
with `appDir: "."`.

## Invariants every repo keeps

- The browser only navigates to `http://localhost:<port>`; `hostMappings`
  targets are fixed to 127.0.0.1; `denyHosts` cuts what a baked LAN URL or
  error-reporting DSN would otherwise reach.
- Evidence naming is fixed: `<slug>-<iphone|desktop>-<fold|full>.jpg`, slug
  `home` for `/`, otherwise the route lower-cased with non-alphanumerics → `-`.
  JPEG q70 fold, q60 full (first 4000 px).
- Fatal: horizontal overflow, error boundary, page error, thin page, no page
  inset at 390, and (opt-in) HTTP status. Reported only: console errors,
  failed requests, small tap targets, blocked requests.

## Adding a repo

1. Confirm `next.config` has `output: "standalone"` and the lane can run the
   production build (DB/backends reachable read-only from the box).
2. Add `.hub-visual.json` at the repo root: a distinct `portBase`, the env the
   standalone server needs (resolve gitignored files from `{main}`), the
   LAN/production hosts in `denyHosts`, and the error-page copy in
   `errorBoundaryText`. Check it with `--print-config`.
3. Add a "Visual gate" section to the repo's `AGENTS.md` (copy a file in this
   directory): trigger paths, the exact command, routes by area, env notes,
   evidence location, hosts never to aim at.
4. Run it once against a lane build and open the JPEGs.
