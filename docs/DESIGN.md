# Design notes

Why things are the way they are. `CLAUDE.md` carries what every session needs;
this file carries the decisions that were arguable, with the evidence that
settled them. Newest first.

## The og:image cards stay in the bundle (2026-09-07)

The cards are drawn by takumi, whose renderer is a 3.6 MB WASM module — by far
the largest thing in this Worker, and the only heavy dependency in it. The
question for a template is whether that module makes the app undeployable for
someone on the free plan, in which case `/.og/*` would have to become an opt-in
that a fork enables, rather than a feature every fork gets.

Measured on the phase-1 tree, `wrangler deploy --dry-run --outdir dist`:

```
Total Upload: 3892.55 KiB / gzip: 1629.28 KiB
```

Broken down by `dist/` artifact (each gzipped on its own, so these sum to a
little under wrangler's figure, which compresses the upload as a whole):

| part                    | raw      | gzip     |
| ----------------------- | -------- | -------- |
| takumi WASM             | 3639 KiB | 1516 KiB |
| worker.js (app + hono)  | 206 KiB  | 53 KiB   |
| Inter 400 + 600 (woff2) | 48 KiB   | 48 KiB   |

**It fits, with room that is not close.** Cloudflare
[removed the compressed size limit on 2026-09-04](https://developers.cloudflare.com/changelog/post/2026-09-04-increased-worker-size-limit/):
there is now one cap, 64 MiB **uncompressed**, identical on Free and Paid. This
Worker is 3.80 MiB uncompressed — **6% of the cap, on the free plan**. It also
fit under the rule that was in force when the question was asked (3 MB gzipped
on Free): 1.59 MiB, 53% of it. Both ways, the answer is the same.

So: no opt-in, no flag, no second entry point. Every fork gets unfurl cards, and
the free plan is a real deployment target for this template rather than a
disclaimer in the README.

The constraint left worth watching isn't size, it's
[startup time](https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time):
a Worker must parse and execute its global scope within 1 second, and a 3.6 MB
WASM module is the kind of thing that eats that budget. Not measured here — the
live instance has never tripped it, and takumi is a static import in
`src/worker.ts`, so if it ever does, the fix is to load the renderer inside the
`/.og/*` handler rather than to shrink the bundle. That limit will bite long
before 64 MiB does; when something feels slow to cold-start, measure startup,
not size.

Re-run the measurement with:

```sh
bunx wrangler deploy --dry-run --outdir dist
```

## The template ships with nobody's domain (2026-09-07)

Every surface that wanted a brand — the explorer header, the login page, the
folder-page footer, the og card — takes it from the request host instead
(`brand()` in `src/lib/ui.ts`). This was chosen over a `CDN_BRAND` var because
the folder pages already derived their links from the request, so deriving the
label too *removes* configuration rather than adding it, and because it makes
preview builds honest: a `*.workers.dev` preview labels itself, and its unfurl
cards stop advertising a production domain they don't serve.

Consequence for forks: there is nothing to set. The Worker wears whatever host
answered, so it is correct on workers.dev the moment it deploys and correct on
a custom domain the moment DNS resolves — no redeploy in between.
