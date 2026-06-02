# cdn explorer

A thin, password-protected file explorer for the personal R2 CDN (`cdn.ramonfabrega.com`).
Companion to the `share` CLI: `share` writes objects, this browses them.

- **`lib/cdn.ts`** — pure helpers (MIME map, key-gen, URL/size formatting). Zero deps,
  no runtime-specific imports → shared with `bin/share` and survives the Worker promotion.
- **`storage.ts`** — local (Bun) storage over the S3 API, using the same `passage` creds
  as `share`. Swapped for an R2 binding when promoted to a Worker.
- **`server.ts`** — Hono app: password gate (signed cookie) + `/api/list` + serves the UI.
- **`public/index.html`** — hand-built vanilla explorer (folders, search, copy/open, paging).

## Run locally

```bash
cd cdn
bun install
CDN_PASSWORD=yourpass bun run dev   # http://localhost:3000  (port matches `tunnel`)
```

Preview on your phone: start the local server, then `tunnel` to expose `localhost:3000`.

## Promote to a Worker (later)

Same Hono routes + UI run unchanged on Workers. The only swaps:
1. `storage.ts` → an R2-binding variant (`env.BUCKET`, credential-less).
2. `CDN_PASSWORD` / `CDN_SESSION_SECRET` → `wrangler secret put`.
3. Add `wrangler.toml` with the R2 binding + a custom domain (e.g. `files.ramonfabrega.com`,
   keeping the existing `cdn.*` direct-R2 serving untouched).
