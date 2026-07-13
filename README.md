# cdn explorer

A **Cloudflare Worker** that *is* `cdn.ramonfabrega.com`. The apex (`/`) serves a password-gated
admin/cleanup **explorer**; every other path streams the matching R2 object — public, cached,
range-capable (this is what `share` links hit). One Worker owns both the CDN and its admin UI.

Companion to the `share` CLI: `share` writes objects (namespaced, with extensions), the explorer
finds / previews / prunes / re-organizes them. Hono + the R2 binding — **no `passage`/S3 anywhere**.
The `share` CLI uploads *through* the Worker (`POST /api/upload`, one bearer token) instead of
signing S3, so the CDN owns every write. The CLI shares **no code** with the Worker — it sends the
bytes + the bearer and prints the URL the Worker returns; the classification lib stays server-side.

## Files

Source lives under `src/` (Worker app + pure lib + tests); `public/` holds the static UI; the
package configs (`wrangler.jsonc`, `tsconfig.json`, …) sit at the cdn root.

- **`src/lib/cdn.ts`** — pure, Worker-internal helpers: MIME map, key→ext classification, and the
  public-URL builder. Zero deps, no runtime-specific imports (own `extname`) → trivially testable.
- **`src/lib/ui.ts`** — shared design tokens + formatters for the server-rendered surfaces (folder
  listing, login, og:image cards): the OKLCH base palette (mirror of `styles.css`),
  type-badge hues, `href`/`fmtSize`/`fmtDate`. Pure and dep-free like the rest of `lib/`.
- **`src/worker.ts`** — the Worker. Hono `<{ Bindings: Env }>`. Gates `/` + `/api/*` (signed
  cookie, **fail-closed** — no `CDN_PASSWORD`, no login); everything else is public.
  `GET /` inlines `index.html`/`styles.css`/`app.js` from the **`ASSETS`** binding into one
  self-contained doc (no FOUC, even on GPRS). `GET|HEAD /<key>` serves the R2 object from
  **`BUCKET`** — Range + conditional (`If-None-Match`) + edge cache (`Cache-Control` + Cache API).
  **Folder share links**: `GET /<prefix>/` renders a public read-only listing of that prefix
  (via `src/folder.tsx` — breadcrumbs, type badges, subfolder links; `noindex`, `max-age=300`,
  never edge-cached so mutations show within minutes), and `/<prefix>` without the slash 301s to
  it when the prefix has content — the "natural" link for a set of uploads
  (`…/golf-sim/sfx-family/`) just works. Public by design: the objects under a prefix are public
  anyway; the page only reveals sibling keys within a prefix someone already has.
  `/api/tree|folder|move|rename|delete|permanent` (move/delete take a single key or batch `keys[]`).
  `POST /api/upload?key=<key>[&permanent=1]` streams the raw body into `BUCKET` (content-type from
  the key's extension) — the only write path. It also accepts an `Authorization: Bearer
  CDN_UPLOAD_TOKEN` (the `share` CLI), scoped to upload alone; the destructive APIs still need the
  cookie. Every write purges the touched keys from the edge cache (Cache API), so overwriting a key
  serves the new bytes immediately. A `scheduled` handler runs the daily expiry sweep.
- **`src/folder.tsx`** / **`src/login.tsx`** — the server-rendered pages (folder listing, sign-in)
  as `hono/jsx` components (auto-escaped; string out via `folderPage()`/`loginPage()`). esbuild
  (wrangler + vitest) transpiles `.tsx` from the tsconfig `jsx` fields — no build step, no new deps.
  Folder pages carry `og:`/`twitter:` unfurl meta pointing at the card route below (canonical
  `https://cdn.ramonfabrega.com` URLs — scrapers need absolute, and the Worker owns one host).
- **`src/card.ts`** — the 1200×630 og:image card `GET /.og/<prefix>.png` renders, drawn by
  [takumi](https://github.com/kane50613/takumi)'s WASM renderer (the one real dependency added;
  ~1.6 MB gz total on a 10 MB paid limit — wrangler resolves the package's `workerd` export
  condition, no config). A plain takumi node tree — no React, no JSX. Left: the explorer's
  Overview **sunburst** in miniature, drawn as concentric conic-gradient circles (no canvas):
  same 9-slot palette + design rules as `app.js` — wedges by subtree bytes (via `listSubtree`),
  tail rolled into a "smaller items" wedge, outer ring faded via `color-mix`, ring count adapting
  to real depth, totals in the hole. Right: the folder page in miniature — a listing panel
  (subfolders first, name + type badge + size, capped with `+ N more`) in the `lib/ui.ts` badge
  hues. Fixed dark theme. Two Inter weights ship as `src/assets/*.woff2` via a
  wrangler `Data` rule (~24 KB each). Dot-prefixed route à la `.keep`, so it can't shadow a real
  key; cached like the page (`max-age=300`, no edge cache).
- **`src/storage.ts`** — R2 ops over the **`BUCKET`** binding: `tree()`, `listFolder` (one
  delimited level, feeds the public folder pages), `listSubtree` (full-depth keys + sizes, one
  list page — feeds the card's sunburst), `createFolder`, `move`, `rename`, `remove`,
  `setPermanent`, `sweep`. Each takes the bucket (per-request `env`).
  Move/rename are copy+delete (customMetadata travels along); mutations return the keys to purge.
- **`wrangler.jsonc`** — Worker config: R2 binding, `assets` (`run_worker_first` → the gate covers
  them), the `cdn.ramonfabrega.com` custom-domain route. `Env` is generated by `wrangler types`
  (gitignored `worker-configuration.d.ts`).
- **`public/`** — vanilla, event-delegated, zero-build UI: `index.html` + `styles.css` + `app.js`
  (separate on disk; the Worker folds them into one response). Left **folder rail** (scope by prefix)
  · flat sortable/searchable list · ⌘K search · `⋯`/right-click menus · centered modals · animated delete
  · **upload** (mainbar button + drag-anywhere dropzone → `POST /api/upload`, into the current scope).
  The default view is **Overview** — a DaisyDisk-style canvas **sunburst** of the bucket (design
  notes lifted from `~/code/fun/disk`): hue by top-level folder (depth only fades toward the page),
  CVD-checked 9-slot palettes per theme, the tail of each ring rolled into one "smaller items"
  wedge, and the ring count adapting to the scope's real depth (a flat folder = one fat donut).
  Beside it, a size-ranked children list with proportional `scaleX` bars; hover syncs both ways.
  Click a wedge/row to drill — a 0.55s cubic zoom where survivors morph, newborn rings unfold
  staggered outward, outgoing marks sink into the hole, and the center total **counts** between
  values instead of swapping; interrupting mid-zoom catches up from the on-screen state (honors
  `prefers-reduced-motion`). Click the center to go up; breadcrumbs + ↗ jump into the file list.
  Draw and hit-test share one pure geometry function, so clicks always match pixels. Search is a
  literal token grammar: bare substring, `kind:image`/`type:png`, `size:>10mb`, `age:>1w`,
  `is:permanent` (AND-ed), searching everything from any view. The URL mirrors the view —
  `/#/<prefix>/` is the Overview drilled to a folder (the explorer twin of the public
  `/<prefix>/` share page) and `/#f/<prefix>/` a scoped file list; drills push history entries,
  so **Back is an animated zoom-out** and deep links restore on load.
  First paint is a **static-HTML skeleton** baked into `index.html` (sized to the loaded UI) so it
  paints in the same frame as the shell — **never built by JS** (that reintroduces a 3-paint flash);
  `app.js` overwrites `#rail`/`#list` with real data on load.

## Run locally

```bash
cd cdn
bun install
bun run types          # generate worker-configuration.d.ts (Env) — rerun when bindings change
bun run dev            # wrangler dev → http://localhost:8787, local R2 sim + .dev.vars
```

`.dev.vars` holds `CDN_PASSWORD` / `CDN_SESSION_SECRET` / `CDN_UPLOAD_TOKEN` for local dev
(gitignored — the token also feeds `wrangler types`, so `Env` includes it). For real R2 data
locally use `bun run dev --remote` (needs `wrangler login`).

- `bun run test` — `vitest` in workerd: `src/lib/` units, `src/storage.ts`, and the Worker routing
  (`src/worker.test.ts`, via `SELF`) against a **local Miniflare R2** (`@cloudflare/vitest-pool-workers`,
  per-test isolation). Hermetic — no real R2, no `passage`.
- `bunx biome check --write .` — format + lint (`biome.jsonc`).
- One tsconfig (`tsconfig.json`, Worker types covering `src/`); `bin/share` is `@ts-nocheck` Bun glue, fully self-contained (imports nothing from cdn).

## Deploy

Live at **https://cdn.ramonfabrega.com** (Worker custom domain — the `routes` entry in
`wrangler.jsonc`, which replaced R2's custom-domain serving on the bucket).

Deploys are **automatic**, via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
— Cloudflare's own Git CI, connected to `ramonfabrega/dotfiles`. Merge to `master` and the Worker
ships; open a PR and you get a preview URL. `bun run deploy` still works for an out-of-band push.

### CI (dashboard: Worker → Settings → Builds)

The whole config lives in the Cloudflare dashboard — Workers Builds has no in-repo config file, so
it is recorded here instead:

| Setting | Value |
| --- | --- |
| Root directory (“Path”) | `/cdn` |
| Build command | `bun install && bun run test` |
| Deploy command | `npx wrangler deploy` |
| Non-production branch deploy command | `npx wrangler versions upload` |
| Production branch | `master` |
| Builds for non-production branches | enabled |
| Build watch paths (include) | `cdn/*` |
| Build caching | enabled |

Mind the two path conventions — they differ, and the dashboard doesn't say so. The **root
directory** is dashboard-relative and leading-slashed (`/cdn`, matching Cloudflare's own
`/workers/product-service/` example); the **watch paths** are **repo-root**-relative and bare
(`cdn/*`). Watch paths are also the thing that makes a Worker-in-a-dotfiles-monorepo viable at all:
commits touching `bin/`, `claude/`, or anything outside `cdn/` never trigger a build. (Cloudflare's
`*` matches zero or more characters, `/` included, so `cdn/*` covers `cdn/src/**` too.)

The test suite runs as part of the build command, so a red vitest blocks the deploy. It
deliberately does **not** run `biome check`: `public/app.js` + `public/styles.css` are already
failing lint, and that debt shouldn't gate deploys — fix them, then add it.

Build watch paths, caching, and the rest are only editable **after** the repo is connected (the
connect modal doesn't show them). Connecting does not build anything retroactively — the first
build needs a fresh commit.

### Previews

A PR builds a **version** rather than a deployment: uploaded, addressable, but serving no traffic.
Cloudflare comments two URLs on the PR — a per-commit one and a stable
`<branch>-cdn-explorer.<subdomain>.workers.dev` alias. Requires `"preview_urls": true` in
`wrangler.jsonc` (there's no `workers.dev` route to inherit it from — the custom domain took it).
`bun run preview` uploads one by hand.

**A preview shares production's bindings.** Workers has no per-environment binding overrides, so a
preview version talks to the *live* `cdn` R2 bucket with the *live* secrets — deliberate (an
explorer with an empty bucket tells you nothing), but it means the delete / move / rename APIs on a
preview URL hit real objects. The blast radius is bounded by what a version *cannot* do: it never
answers on `cdn.ramonfabrega.com` and it never runs the cron sweep — only the deployed version
does. The `CDN_PASSWORD` gate covers previews exactly as it covers prod.

### Secrets

One-time, and shared by every version incl. previews (after the first deploy, which must exist
before secrets can be set): `wrangler secret put CDN_PASSWORD` / `CDN_SESSION_SECRET` /
`CDN_UPLOAD_TOKEN`. The upload token is the `share` CLI's only credential — store the same value in
`passage` at `tokens/cdn/upload-token` (filed by app, not provider — it's a bearer we issue, not a
CF cred).

## Conventions

- Namespace by project (`cuanto/`, `test/`, …). Empty folders = a hidden `.keep` marker.
- Classify by **key extension only** (no content-type inference) — the CLI guarantees extensions.
- Move/rename change the key → **the public URL changes**; the UI confirms.
- **Expiry** lives in the Worker, not R2: a daily cron (`triggers.crons`) runs `sweep()`, deleting
  objects >30 days after upload **unless flagged `permanent`** (R2 customMetadata). The bucket's
  old blanket 30d lifecycle rule is gone (R2 rules are prefix-only — no per-object exemptions);
  only the multipart-abort rule remains on the bucket. Flag at upload (`share … --permanent`,
  `?permanent=1`) or toggle in the UI (∞ badge, `is:permanent` search); overwrites keep the flag.
- **Caching**: `.xml` serves `max-age=300` (mutable pointers — mux's Sparkle appcast is overwritten
  in place every release); everything else `max-age=86400, s-maxage=3600` (a day in clients, an
  hour per edge POP). Every write purges its keys from the local POP's cache, so re-upload → fetch
  is immediately fresh; other POPs age out within the hour.

## Remaining

`CDN_UPLOAD_TOKEN` is set on the live Worker + in `passage` (`tokens/cdn/upload-token`) and the
Worker is deployed. Still to do:

1. **Retire the old R2 S3 keys** — revoke the R2 access key in the Cloudflare dashboard and drop
   the two `passage` secrets under `tokens/cloudflare/personal/r2-cdn/` (nothing signs S3
   anymore; the live upload path has been smoke-tested). Revoke first, then `passage rm` — don't
   destroy the local copy of a still-valid key.
2. Clear the last dev fixtures: `test/perm.txt`, `test/probe.xml`, `test/x.txt` (perm.txt is
   flagged permanent, so the sweep will never take it — delete via the explorer or
   `wrangler r2 object delete cdn/test/… --remote`). The rest of the old fixture is gone: the
   daily sweep already ate `dotfiles/` and `screenshots/`, and `cuanto/` now holds live share
   links (real work product — do **not** wipe it).

Nice-to-haves, not blockers: prefix-scoped TTLs (e.g. an ephemeral `24h/` namespace), a
multi-select bulk bar. mux's Sparkle artifacts (`mux/appcast.xml`, `mux/MuxMac-latest.zip`) had
already been eaten by the old blanket 30d rule — the next mux release must publish them with
`share … --permanent` (flag needed once per key; it sticks across later overwrites), after which
an installed app updating after a months-long release gap still finds them.

## Recent arcs

Both post-#8 arcs have shipped: **arc 1** — server pages to `hono/jsx` (`src/folder.tsx`,
`src/login.tsx`, shared tokens in `src/lib/ui.ts`, zero new deps; the client explorer stayed
vanilla/zero-build — the inline-one-doc boot and static skeleton are load-bearing, per the
single-paint rule above) — and **arc 2** — og:image unfurl cards (`src/card.ts` + the `/.og/`
route + meta on folder pages; raw file URLs already unfurled natively via content-type, folder
pages were the gap). Ideas deliberately left on the table: cards (or pretty file pages) for
non-visual file types like zips/logs; purging card caches on write (today `max-age=300` just
ages out — a stale card for ≤5 min is fine).
