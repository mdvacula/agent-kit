# newjerseybrews — visual gate snippet

Pastes, all committed on `develop`:

0. Add `".claude/**",` to the `ignores` array in `eslint.config.mjs` (the
   drain's workflow copy lives at `.claude/workflows/hub-drain.js`; see
   `../main-gate/newjerseybrews.md`).
1. [`newjerseybrews.hub-visual.json`](newjerseybrews.hub-visual.json) →
   `newjerseybrews/.hub-visual.json` (drop the file in as-is).
2. The section below → `newjerseybrews/AGENTS.md`, under "Agent lane facts"
   (after the **e2e** bullet is a good spot).

---

- **Visual gate** (lane-run, required for page-affecting diffs).
  - **Triggers:** any diff touching `src/app/(frontend)/`, `src/components/`
    (except `src/components/admin/`), `src/styles/` (`globals.css` `@theme`
    tokens), `src/app/icon.tsx` / `apple-icon.tsx` / `error.tsx`, or
    `next.config.ts` headers/redirects/rewrites. Payload admin
    (`src/app/(payload)/`, `src/components/admin/`), API routes, scripts and
    migrations do not trigger it.
  - **Command** (after `pnpm build` passes in the lane):
    `node ~/.claude/scripts/lane-visual.mjs --repo <worktree> --lane <N> --routes <routes> --out openspec/changes/<change>/evidence/<task-id>`
    — serves YOUR worktree's own `.next/standalone/server.js` on
    `localhost:3200+N` (never the box container on :3700, never
    `newjerseybrews.local`) and probes it at iPhone 13 (390) and desktop
    (1440). `.hub-visual.json` supplies the rest. Exit 1 = a hard invariant
    failed (overflow, error boundary, page error, thin page, no inset at 390,
    or an HTTP status ≥ 400): fix the page, not the probe or its config.
    Exit 2 = it could not run (no standalone build, port taken, DB down) —
    say so in your report; never skip silently.
  - **Routes by area** (probe every route your diff can change; slugs below
    exist in the box DB — use another only if the task is about it):
    home `/` · directory `/breweries` (search: `/breweries?q=<term>`) ·
    brewery detail `/brewery/kane-brewing` (plus a sparse listing if the
    task is about missing data) · map `/map` (WebGL via SwiftShader; judge
    the pins/tiles in the screenshot, a grey canvas is a finding) · region
    `/region/jersey-shore` · county `/county/monmouth` · near
    `/near/<place>` · amenity `/amenity/<amenity>` · trails `/trails`,
    `/trail/<slug>` · static `/about`, `/privacy` · shared shell
    (`src/components/layout/`, `globals.css`): `/`, `/breweries`,
    `/brewery/kane-brewing`, `/map` at minimum.
  - **Env the standalone server needs:** the main checkout's `.env`
    (`DATABASE_URI` → the box postgres at `127.0.0.1:5436`, read-only,
    `PAYLOAD_SECRET`) — lanes have no `.env`, so `.hub-visual.json` reads
    `{main}/.env`, and for `pnpm build` itself export the same file's values
    or copy it into the lane (gitignored; never commit it, never print it).
    The config also sets `BASEMAP_DIR`/`MEDIA_DIR` to the main checkout's
    `data/basemap` and `media`, points `NEXT_PUBLIC_APP_URL` at the probe's
    own port for the server, and blanks the Sentry DSNs. Requests to
    `newjerseybrews.local`, `njbrews.local`, `newjerseybrews.com` and
    `glitchtip.local` (baked into a build from the box `.env`) are aborted and
    listed under "blocked" in the report — expected, not a defect; so is one
    console 404 for `/umami/script.js` (a lane build has no `UMAMI_ORIGIN`
    rewrite). Stale `.next/types` / `.next/dev/types` are deleted by
    `hub-lane-setup.sh` on every lane reset; if the build or `pnpm
    type-check` fails only on files under `.next/`, delete those two
    directories and rebuild. Serving
    the page reads the box DB exactly as `pnpm build`'s prerender already
    does; never run migrations or research scripts against it.
  - **Evidence:** `openspec/changes/<change>/evidence/<task-id>/` —
    `report.md`, `report.json` and `<route>-<iphone|desktop>-<fold|full>.jpg`.
    Commit it with your code (the one exception to zero-bloat; ≤800 KB each)
    and open the JPEGs yourself before committing — the reviewer will.
  - **Never from a lane:** a browser aimed at `newjerseybrews.local`,
    `njbrews.local`, `127.0.0.1:3700` (the box container) or production
    `newjerseybrews.com` / Railway.
