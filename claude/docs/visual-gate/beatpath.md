# beatpath — visual gate snippet

Paste the section below into `beatpath/AGENTS.md` under "Agent lane facts",
replacing the existing **Visual acceptance** bullet (its owner-run half is
kept verbatim at the end). Optionally also commit
[`beatpath.hub-visual.json`](beatpath.hub-visual.json) as
`beatpath/.hub-visual.json` — it is byte-for-byte the behaviour the script
already applies to beatpath without one (the built-in profile), so adding it
changes nothing today and makes the settings reviewable in beatpath's own
diffs. When `mobile-acceptance-automation` group 3 vendors the probe to
`tools/capture/lane-visual.mjs`, add `"delegate": "tools/capture/lane-visual.mjs"`
to that file instead of rewriting the kit script into a shim (design D2).

---

- **Visual gate** (lane-run, required; decided 2026-10-14, owner: "mobile
  acceptance needs to not be all owner check").
  - **Triggers:** any diff touching `frontend/src/app/`,
    `frontend/src/components/`, `frontend/src/app/globals.css`, any
    `*.module.css`, or a token/style file the pages read.
  - **Command** (after `pnpm --filter frontend build` passes in the lane):
    `node ~/.claude/scripts/lane-visual.mjs --repo <worktree> --lane <N> --routes <routes> --out openspec/changes/<change>/evidence/<task-id>`
    — serves YOUR worktree's own `frontend/.next/standalone` build on
    `localhost:3100+N` and probes it signed-out at iPhone 13 (390) and
    desktop (1440). Exit 1 = a hard invariant failed (fix the page, not the
    probe); exit 2 = it could not run (say so in your report).
  - **Routes by area** (probe every route your diff can change; for a
    `[slug]` route open the list page and use a real slug it links to):
    home `/` and `/home-next` · coverage `/coverage` (search:
    `/coverage?q=<term>`) · events `/events`, `/event/<slug>`,
    `/this-week` · artists `/artists`, `/artist/<slug>` · venues
    `/venue/<slug>` · festivals `/festival/<slug>` · search `/search` ·
    shared shell (`SiteHeader`, `BottomDock`, `Footer`, `globals.css`): `/`,
    `/coverage`, `/events` at minimum.
  - **Env the standalone server needs:** `frontend/.env.local` (copied into
    the lane by `hub-lane-setup.sh`) plus `CONVEX_URL=http://127.0.0.1:3210`
    (the probe sets it; the browser reaches Convex as `beatpath-api.local`
    mapped to 127.0.0.1). A fresh lane must build `packages/shared` first
    (`pnpm --filter @beatpath/shared build`) or `next build` cannot resolve
    `@beatpath/shared`; stale `frontend/.next/types` is deleted by
    `hub-lane-setup.sh` on every reset. The page's own signed-out Convex reads are the one
    sanctioned live read from a lane.
  - **Evidence:** `openspec/changes/<change>/evidence/<task-id>/` —
    `report.md`, `report.json` and `<route>-<iphone|desktop>-<fold|full>.jpg`.
    Commit it with your code (the one exception to zero-bloat; ≤800 KB each)
    and open the JPEGs yourself before committing — the reviewer will.
  - **Never from a lane:** `tools/capture/`'s own suite and
    `capture.sh --login` (they carry the owner's session and point at
    `beatpath.local` / beta) — a lane never aims a browser at
    `beatpath.local` or `beta.thebeatpath.com`. Full runbook:
    `openspec/changes/mobile-acceptance-automation/` until
    `docs/ops/lane-visual-acceptance.md` lands.
