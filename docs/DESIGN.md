# Design notes

Why things are the way they are. `CLAUDE.md` carries what every session needs;
this file carries the decisions that were arguable, with the evidence that
settled them. Newest first.

## What `cdn setup` refuses to do (2026-09-07)

Setup automates the post-deploy checklist. Two steps it deliberately does not,
and both refusals are the interesting part.

**Browser Cache TTL is read, never written.** The API takes an integer, and
which integer means the dashboard's "Respect Existing Headers" is not documented
anywhere on developers.cloudflare.com: the zone-settings schema says only
`minimum 0`, and all three cache pages describe the option purely as a dropdown
label. `0` is the widespread belief and is very likely right — and it is still
not good enough, because this setting is ZONE-WIDE. Being wrong would not
misconfigure this CDN; it would change browser caching for every other hostname
on somebody's domain. So the step reads the value, says what to set it to, and
says why it isn't setting it. If the mapping is ever confirmed, this becomes four
lines and a test.

**It does not create a Zero Trust organization.** Creating one picks a permanent
team domain — `<name>.cloudflareaccess.com`, which then appears in every login
URL forever. That is a naming decision, and a setup command should not make one
on your behalf. It reports the absence and asks you to make it once.

Two more findings worth recording, both from reading the docs rather than
remembering them:

**Access for Workers IS API-drivable**, via `POST /accounts/{id}/access/apps`
with `destinations: [{ type: "preview_worker", worker_id }]`, and protecting a
Worker that way covers "routes, Custom Domains, `workers.dev` hostname, and
previews" in one application. That is strictly better than the two hostname
applications setup creates today, because it also closes the preview gap the
Previews section of the README describes — a preview shares production's
bindings and is currently guarded only by the password. It is not built because
the destination takes the Worker's *id*, not its name, and that is one more
lookup whose shape has not been verified. Scoped, not done.

**One-time PIN is no longer the default identity provider.** As of 2026-06-18
new Zero Trust organizations get Cloudflare's own IdP instead, and OTP has to be
created explicitly. This matters because it was the assumption under "Access
needs nothing else configured": it still needs nothing, but for a different
reason, and an instance that expected an emailed PIN will get a different login
screen than the docs written before that date describe.

## `--dry-run` reads for real (2026-09-07)

The promise a dry run makes is not "it prints something plausible", it is "this
is what the real run will do". The only way that promise holds is if both modes
take the same code path — so `--dry-run` swaps the injected `fetch` for one that
passes GETs through and stops at the first write, rather than branching inside
each step.

Reads going through is the load-bearing half. A dry run whose reads were also
faked could only ever describe a hypothetical account: it could not tell you the
route is already configured, or that a token by that name already exists, which
is most of what anyone wants a dry run for. Every step is tested in both modes,
and the dry one asserts that nothing was written — not the config file, not the
account, not a command.

## One repo, two sides, one number between them (2026-09-07)

The Worker and its clients are a contract: a route shape on one side, a parser on
the other. They live in one repository, with the Worker at the root (the Deploy
button's expectation) and everything client-side in `packages/cli/` as a bun
workspace.

A second repository for the client was considered and rejected, because it is the
thing that manufactures drift. Here, one PR changes a route and its client
together; one `bun run check` proves they still agree; the button clones the whole
tree, so a fork carries the client inert whether or not it ever runs it; and
publishing later is `bun publish` from the package directory rather than a
migration. The phase-6 plugin manifest will point at the same directory.

`macos/` stays outside the package. It is a human install — a bash script and a
signed Shortcut — not something anyone would `npm i`.

**The contract is a number, because the two sides are allowed to be different
ages.** This repo is a template: a fork can lag upstream by months and still be
talked to by a client from today. So `GET /api/auth` answers `{ contract: 1 }`,
and the client refuses a version it does not know, naming both. The failure that
buys is legibility — without it, a mismatch shows up three calls later as a field
that isn't there, which reads like a bug in whichever side you happen to be
looking at.

`SUPPORTED_CONTRACTS` is a list rather than a constant so that adding 2 does not
silently drop 1: dropping support should be a decision someone makes, not a
side effect of adding support for something else. Bump the number only for a
change a current client cannot survive — adding a field is not one of those.

## The Cloudflare API gets a door before it gets callers (2026-09-07)

`packages/cli/src/cloudflare.ts` has no production caller. It exists because
phase 5 (`cdn setup`) is the post-button checklist done from code — the
custom-domain route, the Zero Trust app and its bypass, Browser Cache TTL,
minting the narrow purge token — and every one of those is the same three lines
with a different path. Writing them once, now, means that phase adds calls rather
than plumbing, and its tests are the caller in the meantime.

The one thing worth knowing before writing any of those calls: **Cloudflare
returns `200` with `success: false`**. The status code is not the check, and a
client that trusts it accepts failures as wins. That is pinned by a test rather
than by a comment.

`fetch` is injectable for the same reason it is in `upload.ts` — and not only for
tests: `cdn setup --dry-run` has to say what it *would* do, and a client that can
be handed a recorder is a client that can be handed a dry run.

## Two runtimes, two test runners (2026-09-07)

The hooks run in Bun and the Worker runs in workerd, and that is not a thing to
paper over: `Bun.file` does not exist in workerd, and `R2Bucket` does not exist
in Bun. So `hooks/` gets `bun:test` and its own tsconfig, `src/` keeps vitest and
the root one, and `bun run check` runs both — CI stays one command, which is the
property that actually mattered.

The load-bearing line is `test: { include: ["src/**/*.test.ts"] }` in
`vitest.config.ts`. Vitest's default glob would otherwise sweep `hooks/*.test.ts`
into workerd, where they fail on a global that isn't there — a confusing failure,
because the code is fine and the runner is wrong.

Note the hazard CLAUDE.md already warns about, from the other side: `bun test` is
Bun's own runner and shadows a `test` script silently. That is why `check` calls
`vitest run` directly rather than `bun run test`, and why `bun test hooks/` is
written with a path — it is the real runner, deliberately, aimed at the one
directory that wants it.

## The hooks stopped shelling out (2026-09-07)

The two mirror hooks used to spawn a `share` CLI, and patch `PATH` so that CLI
could find Homebrew, so it could find a password manager, so it could find the
upload token. Four links, one purpose: answer *where is the token*.

`packages/cli/src/hosts.ts` answers it in one place — `~/.config/cdn/hosts/<host>.env` —
and the chain collapses. What is left is a POST with a bearer, which `fetch`
already does. The hooks now depend on nothing being installed: no CLI on disk, no
PATH assumption, no password manager.

Format and layout are chosen by the readers, not by taste. Three are meant to
share these files — a Bun hook, a Bun CLI, and a bash script on a Mac with no
`jq` — and dotenv is the only shape all three parse natively (wrangler's
`.dev.vars` is already it). One file per host rather than one file with sections,
because then "which host" is a filename: `ls` is the list command and `rm` is the
logout.

**Two configured hosts and no `CDN_HOST` is an error, not a guess.** This is the
one place the resolver could have been convenient and isn't. Picking the
alphabetically-first host would mirror someone's file to the wrong organization,
and that is a failure you learn about from the recipient. Every error names the
path to create, because "not configured" leaves you guessing at a directory you
have never seen.

Resolution returns a value rather than throwing: its callers are hooks that must
never fail the tool they ran after, so a missing config has to be something they
can turn into one line of transcript.

Routing stays out of the code entirely. Which host a session mirrors to is
`CDN_HOST` in that scope's Claude Code settings `env` — user-level for the
default, a project's `.claude/settings.json` for a repo that mirrors elsewhere.
A directory→host map inside the hooks was considered and rejected: the settings
already resolve user → project → local in the right order, and a second map is a
second thing to keep in sync with the first.

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
