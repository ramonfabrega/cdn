# cdn explorer

A password-protected **admin/cleanup UI** for the personal R2 CDN (`cdn.ramonfabrega.com`).
Companion to the `share` CLI: `share` writes objects (namespaced, with extensions), this finds /
previews / prunes / re-organizes them. `share` already returns the URL, so this is for
*managing* what's there — not grabbing the link you just made.

## Files

- **`lib/cdn.ts`** — pure helpers (MIME map, key→ext classify, key-gen, URL/size formatting).
  Zero deps, no runtime-specific imports → shared with `bin/share`, survives the Worker promotion.
- **`r2-client.ts`** — Bun S3 client, creds via `passage`. Shared by `storage.ts` and `bin/share`.
- **`storage.ts`** — R2 ops: `tree()` (full enriched list), `createFolder`, `move`, `rename`,
  `remove`. Moves/renames are copy+delete (no native copy). Swap for an R2 binding on a Worker.
- **`server.ts`** — Hono: password gate (signed cookie), `/api/tree` + `/api/folder|move|rename|delete`
  (move/delete take a single key or batch `keys[]`). `GET /` inlines css+js into one self-contained
  document (no render-blocking subrequest → no FOUC, even on GPRS); `Cache-Control: no-store`.
- **`public/`** — vanilla, event-delegated, zero-build UI: `index.html` + `styles.css` + `app.js`
  (separate on disk; the server folds them into one response).
  Left **folder rail** (scope by prefix) · flat sortable/searchable list · ⌘K search ·
  per-row + rail-folder `⋯`/right-click menus · centered modals · optimistic animated delete.

## Run locally

```bash
cd cdn
bun install
CDN_PASSWORD=test123 PORT=4321 bun run server.ts   # http://localhost:4321
```

- `bun test` — unit (`lib/`) + R2 e2e (`storage.test.ts`, isolated `__test__/` prefix, auto-cleaned).
- `bunx biome check --write .` — format + lint (config in `biome.jsonc`).
- Heads-up: `bun --hot` doesn't reliably reload imported modules — restart after `storage.ts`/`lib` edits.

## Conventions

- Namespace by project (`cuanto/`, `test/`, …). Empty folders = a hidden `.keep` marker.
- Classify by **key extension only** (no content-type inference) — the CLI guarantees extensions.
- Move/rename change the key → **the public URL changes**; the UI confirms.
- 30-day expiry is planned as an **R2 lifecycle rule** (prefix-scoped), not app code.

## Remaining

1. UI refinement — maybe a multi-select bulk bar. (Theme done: OKLCH tokens on one hue,
   light + dark via `light-dark()` — see the `:root` legend in `styles.css`.)
2. **Deploy** to a Worker: `storage.ts` → R2-binding variant (`env.BUCKET`), `CDN_PASSWORD`/
   `CDN_SESSION_SECRET` → `wrangler secret`, `wrangler.jsonc` + custom domain; then the lifecycle rule.

> A light test fixture (~23 objects across `cuanto/ test/ dotfiles/ screenshots/` + root) is currently
> in the bucket for development — clear it before calling this done.
