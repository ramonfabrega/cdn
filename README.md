# cdn — your own CDN, in one click

A **Cloudflare Worker** that *is* a CDN. Every path streams an object out of an R2 bucket — public,
cached, range-capable — and the apex (`/`) is a password-gated **explorer** for the same bucket:
sunburst overview, folder rail, drag-anywhere upload, a search grammar. Folder prefixes render as
public listing pages with generated unfurl cards. One authenticated `POST /api/upload` is the only
way in. One Worker owns both the CDN and its admin UI; no S3 client, no signing, no second service.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/ramonfabrega/cdn)

Pressing that forks this repo into your account, provisions an **R2 bucket** and the Worker, wires
**Workers Builds** so every push to your production branch deploys, and prompts you for the secrets
below. You get a working CDN on `<worker>.<your-subdomain>.workers.dev` before you own a
domain — and nothing in this repo names a domain, so the moment you add one, every page, link and
unfurl card starts saying it (the brand is derived from the request host, not configured).

Runs on the **free plan**: the whole Worker is 3.8 MiB uncompressed against a 64 MiB cap — 6% — og
cards and all. See [`docs/DESIGN.md`](docs/DESIGN.md) for that measurement.

### After the first deploy

**1. Set the secrets** (the deploy dialog prompts for them; `wrangler secret put <NAME>` later):
`CDN_PASSWORD` gates the explorer, `CDN_SESSION_SECRET` signs its cookie, `CDN_UPLOAD_TOKEN` is the
bearer every writer uses. Auth fails **closed** — unset means *nobody* gets in, never a default.
`.dev.vars.example` documents all four; copy it to `.dev.vars` for local dev.

**2. Run the rest.** Everything below step 1 is one command:

```sh
export CLOUDFLARE_API_TOKEN=...          # one broad token, used once, never stored
cd packages/cli && bun link              # or: bun packages/cli/bin/cdn.ts

cdn setup --domain cdn.example.com --dry-run     # what it would do
cdn setup --domain cdn.example.com               # do it
cdn setup --domain cdn.example.com --access @example.com   # …and gate it with Access
```

Every step **checks before it acts**, so running it twice is not different from running it once —
which matters, because the state you're in when you reach for it is usually "the last run
half-worked". It reports each step as `present`, `created`, `skipped`, `manual` or `failed`, and
ends by naming what it cannot do at all.

| Step | What it does |
| --- | --- |
| custom domain | Adds the `routes` line to `wrangler.jsonc` and deploys; wrangler provisions the DNS record and certificate. |
| browser cache TTL | **Reads and reports only** — see below. |
| purge token | Mints an account-owned token with *only* Cache Purge on your zone, verifies it, and stores it as `CDN_PURGE_TOKEN`. |
| purge vars | Adds `CDN_ZONE_ID` and `CDN_PUBLIC_ORIGIN` to `wrangler.jsonc`. |
| access | With `--access`: an Access application on the hostname allowing who you named, **plus a bypass on `/api/upload`** so every writer keeps working. |

**The one step it won't do for you.** Browser Cache TTL must be **"Respect Existing Headers"**
(Caching → Configuration) — it's load-bearing and the Worker cannot enforce it, because Cloudflare's
4-hour default *overwrites* the `max-age` of anything served from cache. `cdn setup` reads it and
tells you, but does not set it: the API takes an integer, and which integer means that option is
undocumented, while the setting is zone-wide. Being wrong there wouldn't misconfigure this CDN, it
would change browser caching for every other hostname on your domain. Two clicks, once.

**The token you give it.** One broad token, for one run, read from the environment and written
nowhere. It is *not* `CDN_PURGE_TOKEN` — that one is narrow, account-owned and minted **by** setup,
and conflating them is how a Worker ends up holding a credential that can reconfigure the zone.
Create it at **Manage Account → Account API Tokens** with:

| Permission | Scope | Needed for |
| --- | --- | --- |
| `Zone Read` | the zone | Finding the zone id from your domain |
| `Zone Settings Read` | the zone | Reading Browser Cache TTL |
| `Account API Tokens Read` + `Write` | the account | Listing permission groups, and minting the purge token |
| `Access: Apps and Policies Read` + `Write` | the account | `--access` only — the application and its bypass |
| `Access: Organizations, Identity Providers, and Groups Read` | the account | `--access` only — finding your team domain |

Delete it when setup is done. Everything it configured keeps working; the CDN never uses it again.

**Doing it by hand instead** is entirely reasonable — every step is a documented dashboard action,
and the sections below still describe each one. The route is one line:

```jsonc
"routes": [{ "pattern": "cdn.example.com", "custom_domain": true }],
```

Note that taking a custom domain drops the `workers.dev` route that preview URLs hang off — see
[Previews](#previews).

**On Access and the password.** `CDN_PASSWORD` is one string everyone knows and nobody rotates:
right for one person, wrong for an organization. With Access in front, a verified
`Cf-Access-Jwt-Assertion` **is** the session — set `CDN_ACCESS_TEAM` and `CDN_ACCESS_AUD` (setup
prints both) and a team instance runs with no shared secret at all. The password stays as the
fallback, because a preview URL outside the Access application still has to be reachable. The
assertion is *verified*, never trusted: Access guards the front door, so a request arriving any
other way can set whatever header it likes.

Writers are anything that can `POST` a file with a bearer token: a shell one-liner, a CLI, an
editor hook, a macOS Shortcut. They share **no code** with the Worker — send the bytes, get the URL
back — so the classification and key rules stay server-side and there is exactly one write path to
secure. Four writers ship in this repo: the `cdn` CLI and two Claude Code hooks under
[`packages/cli/`](packages/cli), and a macOS hotkey / Finder action under
[`macos/`](macos/README.md) — bash and curl, so the Mac path needs nothing installed at all.

## The `cdn` CLI

`packages/cli` is the client half of this repo, in one place because a two-sided contract kept in
two repositories drifts: one PR moves a route and its client together, and one `bun run check`
proves they still agree. The button clones the whole tree, so a fork carries the client whether or
not it ever uses it.

```sh
cd packages/cli && bun link       # or run it in place: bun packages/cli/bin/cdn.ts

cdn auth login --host cdn.example.com   # verifies the token, then writes it 0600
cdn up shot.png                          # → https://cdn.example.com/a1b2c3.png
cdn up shot.png notes/                   # a trailing slash is a namespace
cdn up ./dist releases/v2/               # a directory keeps its structure
cdn up app.zip releases/app.zip -p       # exempt from the 30-day sweep
cdn auth status                          # which host wins, and which rule decided
```

It is built on [incur](https://github.com/wevm/incur), which is why there is no argument parsing,
help text, output formatting or skill file written by hand: the schemas produce all four. `--json`
gives an envelope with `ok`/`data`/`error`; an auth failure answers with the exact
`cdn auth login --host …` that fixes it; `cdn --llms` describes every command to an agent, and
`cdn skills add` installs that description into one.

**No `ls` and no `rm`, on purpose.** Listing needs a machine-readable folder manifest, and
publishing one makes the whole bucket enumerable — that is [open thread 1](#open-threads), gated on
thread 2. The destructive routes take the session cookie rather than the upload bearer, because
this token is a machine credential that should be able to add and not remove; deleting is the
explorer's job, where a human confirms. Both are said in `--help` rather than left to be discovered.

### The contract number

`GET /api/auth` answers `{ "contract": 1 }`, and the client refuses a version it doesn't know,
naming both. The two sides are *allowed* to be different ages — this is a template, so a fork can
lag upstream by months while a client from today talks to it — and the number turns that from "a
field I expected isn't there, three calls in" into one legible error at the handshake. Bump it only
for a change a current client cannot survive; adding a field is not one of those.

## Claude Code hooks

Optional, and the reason most files land on the author's instance. Two
[PostToolUse hooks](https://docs.claude.com/en/docs/claude-code/hooks) that mirror what a session
produces onto your CDN:

- **`packages/cli/hooks/artifact-mirror.ts`** — every published Artifact also gets a static copy on your host.
  The claude.ai URL stays the interactive one (comments, versions, runtime capabilities); the mirror
  is the one a person without a Claude account can open. Artifact HTML is authored head-less — the
  publisher adds `<!doctype>`, charset, viewport and a small reset at publish time — so the hook
  reproduces that skeleton, or the mirror renders unstyled and unscaled on a phone. Since it is
  building a `<head>` anyway, it adds unfurl meta (title, the first heading as the description, and
  `noindex`, matching folder pages) so a pasted mirror link reads as something rather than a bare
  URL. No `og:image`: a generic card would say nothing the title doesn't, and a real thumbnail means
  Cloudflare Browser Rendering — see open thread 3.
- **`packages/cli/hooks/user-file-mirror.ts`** — every file Claude attaches also gets a URL. The file cards are
  local paths, which is fine at the machine that wrote them and useless from a phone or an ssh
  session; worse, the usual source is a job's tmp dir that dies with the job.

Neither can fail the tool it follows: every error path exits 0 with one line in the transcript. A
mirror that didn't happen is worth a note, not a broken publish.

### Installing them

**1. A token file** — the same one the CLI and the Shortcut read:

```sh
cdn auth login --host cdn.example.com     # verifies the token, then writes it 0600
```

Or by hand, if you'd rather not install the CLI:

```bash
mkdir -p ~/.config/cdn/hosts
printf 'CDN_TOKEN=%s\n' "$YOUR_UPLOAD_TOKEN" > ~/.config/cdn/hosts/cdn.example.com.env
chmod 600 ~/.config/cdn/hosts/cdn.example.com.env
```

The filename is the host. With exactly one file there, it is the default and nothing else needs
configuring. `CDN_HOST` and `CDN_TOKEN` in the environment override the file (both set ⇒ no file is
read at all). `cdn auth status` prints which host wins and which rule decided.

**2. The hooks, in `settings.json`.** User-level (`~/.claude/settings.json`) for every session, or
a project's `.claude/settings.json` for one repo. Point the command at your clone:

```jsonc
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Artifact",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME\"/.bun/bin/bun \"$HOME\"/code/cdn/packages/cli/hooks/artifact-mirror.ts",
            "timeout": 30,
            "statusMessage": "Mirroring artifact to the CDN…"
          }
        ]
      },
      {
        "matcher": "SendUserFile",
        "hooks": [
          {
            "type": "command",
            "command": "\"$HOME\"/.bun/bin/bun \"$HOME\"/code/cdn/packages/cli/hooks/user-file-mirror.ts",
            "timeout": 120,
            "statusMessage": "Mirroring to the CDN…"
          }
        ]
      }
    ]
  }
}
```

Use an absolute path to `bun` as well as to the hook: a hook inherits whatever PATH launched Claude
Code, which is not guaranteed to carry `~/.bun/bin`. The timeouts are the ceiling for an upload —
the hooks abort just under them, so a stalled connection reports itself instead of being killed
mid-flight and looking like the hook never ran.

Packaging this as a one-command install (a Claude Code plugin) is a later phase; for now it is a
snippet and a token file.

### Routing a session to a different host

Which host a session mirrors to is **config, not code**: set `CDN_HOST` in the `env` of whatever
settings scope should mirror where. There is no map from directory to host inside the hooks, and
there shouldn't be — Claude Code's settings already resolve user → project → local in the right
order, and a second map would be a second thing to keep in sync.

```jsonc
// ~/.claude/settings.json — the default for every session
{ "env": { "CDN_HOST": "cdn.example.com" } }

// <work repo>/.claude/settings.json — this repo's sessions mirror to the company host
{ "env": { "CDN_HOST": "files.work.example" } }
```

Each host needs its own `~/.config/cdn/hosts/<host>.env`. Configure two and leave `CDN_HOST` unset
and the hooks refuse to guess — they name both and tell you to choose. Mirroring a file to the wrong
organization is not a failure you want to learn about from the recipient.

To point a hook at a Worker you're running locally, set `CDN_HOST=localhost:8787`: loopback hosts
are reached over http, everything else over https.

## Files

**The Worker is the root of the repo**, because that is what the Deploy button expects: `src/` is
the Worker, `public/` the static UI, and its config (`wrangler.jsonc`, `tsconfig.json`, …) sits
beside them. **The client half is one workspace package**, `packages/cli/` — the CLI, the Claude
Code hooks, and the host/token resolution all three share. `macos/` stays outside it: it is a human
install, not a package.

Two runtimes, therefore two test runners: the Worker runs in **workerd** (vitest, Miniflare R2) and
everything client-side runs in **Bun** (`bun:test`). `bun run check` runs both, so CI is still one
command.

- **`src/lib/cdn.ts`** — pure, Worker-internal helpers: MIME map, key→ext classification, and the
  public-URL builder. Zero deps, no runtime-specific imports (own `extname`) → trivially testable.
- **`src/lib/ui.ts`** — shared design tokens + formatters for the server-rendered surfaces (folder
  listing, login, og:image cards): the OKLCH base palette (mirror of `styles.css`),
  type-badge hues, `href`/`fmtSize`/`fmtDate`. Pure and dep-free like the rest of `lib/`.
- **`src/worker.ts`** — the Worker. Hono `<{ Bindings: Env }>`. Gates `/` + `/api/*` (signed
  cookie, **fail-closed** — no `CDN_PASSWORD`, no login); everything else is public.
  `GET /` inlines `index.html`/`styles.css`/`app.js` from the **`ASSETS`** binding into one
  self-contained doc (no FOUC, even on GPRS), **streamed** in two flushes: the shell + skeleton
  first (paints before R2 is queried), then the file list embedded as `window.__tree` so the
  client renders with no `/api/tree` round-trip on boot. `GET|HEAD /<key>` serves the R2 object from
  **`BUCKET`** — Range + conditional (`If-None-Match`) + edge cache (`Cache-Control` + Cache API).
  **Folder share links**: `GET /<prefix>/` renders a public read-only listing of that prefix
  (via `src/folder.tsx` — breadcrumbs, type badges, subfolder links; `noindex`, `max-age=300`,
  never edge-cached so mutations show within minutes), and `/<prefix>` without the slash 301s to
  it when the prefix has content — the "natural" link for a set of uploads
  (`…/golf-sim/sfx-family/`) just works. Public by design: the objects under a prefix are public
  anyway; the page only reveals sibling keys within a prefix someone already has.
  A folder's **contents** (files + child folders) link to their **absolute** `cdn.…` url, not a
  root-relative path — so an agent that fetches the page through an HTML→markdown reader keeps a
  usable URL and can `fetch` each file in one hop (a relative `/foo/` survives conversion only as a
  bare path it won't turn back into a URL). Upward nav (breadcrumbs, `..`) stays **relative** on
  purpose: publish real urls for a folder's own contents, not a frictionless path up toward roots.
  `/api/tree|folder|move|rename|delete|permanent` (move/delete take a single key or batch `keys[]`).
  `POST /api/upload?key=<key>[&permanent=1]` streams the raw body into `BUCKET` (content-type from
  the key's extension) — the only write path. It also accepts an `Authorization: Bearer
  CDN_UPLOAD_TOKEN` (scripts, CLIs, hooks), scoped to upload alone; the destructive APIs still need the
  cookie. Every write purges the touched keys from the local POP's cache (Cache API) **and** from
  every other POP (Cloudflare's zone purge API, `CDN_PURGE_TOKEN`), so overwriting a key serves the
  new bytes immediately everywhere — see Conventions. A `scheduled` handler runs the daily sweep.
- **`src/folder.tsx`** / **`src/login.tsx`** — the server-rendered pages (folder listing, sign-in)
  as `hono/jsx` components (auto-escaped; string out via `folderPage()`/`loginPage()`). esbuild
  (wrangler + vitest) transpiles `.tsx` from the tsconfig `jsx` fields — no build step, no new deps.
  Folder pages carry `og:`/`twitter:` unfurl meta pointing at the card route below (absolute URLs
  on the **request origin** — scrapers need absolute, and the Worker answers on several hosts:
  the custom domain, preview builds, `wrangler dev`. Every public URL the Worker mints — folder-page
  hrefs, og meta, `/api/tree` entries, the upload response — derives from the request the same way,
  so a preview build links to itself, never to prod; see `publicUrl` in `lib/cdn.ts`).
- **`src/card.ts`** — the 1200×630 og:image card `GET /.og/<prefix>.png` renders, drawn by
  [takumi](https://github.com/kane50613/takumi)'s WASM renderer (the one real dependency added;
  3.6 MB of WASM, which is still only 6% of the 64 MiB Worker cap on either plan — see
  [`docs/DESIGN.md`](docs/DESIGN.md). Wrangler resolves the package's `workerd` export condition,
  no config). A plain takumi node tree — no React, no JSX. Left: the explorer's
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
  them), preview URLs, the `Data` rule for the card fonts, and the daily sweep's cron. Deliberately
  carries **no `routes` and no `vars`** — a template can't own a domain — and the file's comments
  are the paste-in lines for both. `Env` is generated by `wrangler types` (gitignored
  `worker-configuration.d.ts`), which reads `.dev.vars` for the secret names.
- **`.dev.vars.example`** — the four secrets in dotenv. Two readers: the Deploy to Cloudflare
  button prompts from it, and you copy it to `.dev.vars` for local dev. Descriptions for the deploy
  dialog live in `package.json` under `cloudflare.bindings`.
- **`packages/cli/src/hosts.ts`** — where a token lives: `~/.config/cdn/hosts/<host>.env`, dotenv,
  one file per host (so "which host" is a filename — `ls` lists them, `rm` is the logout), mode
  0600, `XDG_CONFIG_HOME` honoured. Resolution is clig.dev precedence: `--host` beats `CDN_HOST`
  beats the sole `*.env`, with `CDN_HOST` + `CDN_TOKEN` together short-circuiting the file
  entirely; anything ambiguous is an error that **names the path to create**. Every resolution
  reports *which* step decided, which is what `cdn auth status` prints. Returns a value rather than
  throwing — its callers must never fail the tool they ran after.
- **`packages/cli/src/upload.ts`** — the POST, shared by the CLI and both hooks: one bearer, a
  streamed body, and the Worker's own url trusted over a locally built one. Also `verify()`, the
  contract handshake. https except to loopback, which is `wrangler dev`. `fetch` is injectable,
  which is how every test here runs without a network.
- **`packages/cli/src/keys.ts`** — how a local path becomes a key. The CLI's opinion, not the API's:
  the Worker takes whatever key it is given, and each front end decides how a filename becomes one
  (the hooks hash the path instead, so a re-mirror overwrites rather than piles up).
- **`packages/cli/src/login.ts`** — the only writer of a host file. Writes, tightens to 0600, reads
  the mode back, and **deletes the file** if it isn't 0600: refusing to store a token is
  recoverable, storing a world-readable one is not.
- **`packages/cli/src/cloudflare.ts`** — the Cloudflare API behind one door, with the same
  injectable-fetch seam. Its tests pin the trap: Cloudflare answers `200` with `success: false`, so
  the status code is not the check. `readOnlyFetch` is what `--dry-run` runs on — GETs pass
  through, writes stop.
- **`packages/cli/src/setup/`** — `cdn setup`. `wrangler.ts` is the local half (editing
  `wrangler.jsonc` as *text*, so its comments survive; reading the account id and Worker name from
  the tree rather than asking); `zone.ts` and `access.ts` are the API calls; `index.ts` is the
  idempotent orchestration. Every shape came out of Cloudflare's reference, and where a value
  couldn't be confirmed the code declines rather than guessing — see
  [`docs/DESIGN.md`](docs/DESIGN.md).
- **`src/access.ts`** — verifies an Access assertion: RS256 pinned, issuer and audience checked,
  `exp`/`nbf` enforced, signing keys cached with one forced refetch on an unknown `kid` so a key
  rotation costs a fetch and not an outage. Its tests sign real tokens with a generated keypair,
  because every case in them is a way in if the check is wrong.
- **`packages/cli/hooks/lib.ts`** — what is the hooks' alone: `emit` (the PostToolUse contract —
  additionalContext *and* systemMessage, so the URL survives even if the model forgets to relay it)
  and `slugFor` (a path hash, so re-sending one file overwrites its copy while two files sharing a
  basename never collide).
- **`packages/cli/hooks/mirror.test.ts`** — spawns the real scripts and speaks the real contract
  (JSON in, one JSON line out, exit 0) against a `Bun.serve` stub. Importing a function out of a
  hook would pass while the script itself failed to parse stdin, which is the failure that actually
  happens.
- **`packages/cli/skills/`** — the generated `SKILL.md`, committed so a change to a command's schema
  shows up as a diff someone can read rather than a silent change in what agents are told.
- **`macos/`** — the human path: `quickshare` (bash + curl, no runtime — the same hosts file, one
  URL out, always), the Shortcut that calls it, its signer, and
  [`macos/README.md`](macos/README.md) for the GUI settings a fresh import needs. Optional and
  macOS-only; nothing else in the repo depends on it.
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
  paints in the same frame as the shell — **never built by JS** (that reintroduces a 3-paint flash).
  The Worker streams that skeleton first, then flushes the file list inline as `window.__tree`, so
  `app.js` renders straight from the embed with no `/api/tree` round-trip on boot (`init()` reads it;
  `load()` re-fetches only after a mutation).

## Run locally

```bash
bun install
cp .dev.vars.example .dev.vars   # then fill it in
bun run types          # generate worker-configuration.d.ts (Env) — rerun when bindings change
bun run dev            # wrangler dev → http://localhost:8787, local R2 sim + .dev.vars
```

`.dev.vars` holds the secrets for local dev (gitignored). Copy it from `.dev.vars.example` **before**
`bun run types`: wrangler reads the file to type `env.CDN_*`, so without it the generated `Env`
knows about `BUCKET` and `ASSETS` and nothing else. For real R2 data locally use
`bun run dev --remote` (needs `wrangler login`).

- `bun run test` — both suites. `test:worker` is `vitest` in workerd (`src/lib/` units,
  `src/storage.ts`, and the Worker routing via `SELF`) against a **local Miniflare R2**
  (`@cloudflare/vitest-pool-workers`, per-test isolation); `test:bun` is `bun test packages/cli
  macos`, which drives the CLI through incur's own `serve()` seam and spawns the hooks and
  `quickshare` against a stub server on loopback. Both hermetic — no real R2, no network off the
  machine. vitest is scoped to `src/**` in `vitest.config.ts` so it never tries to run Bun code
  inside workerd.
- `bun run lint` — format + lint (`biome.jsonc`); `bunx biome check --write .` to fix in place.
- `bun run check` — exactly what CI runs (install + lint + both suites). Run it before pushing and a
  green build is a formality. (`bun run test`, never `bun test` — that's bun's own runner, which
  would shadow the script and exit 0. The `bun test packages/cli macos` inside the script is that
  runner, on purpose, aimed at the directories that want it.)
- Two tsconfigs, one per runtime: `tsconfig.json` (Worker types, `src/`) and `tsconfig.bun.json`,
  which `packages/cli/` and `macos/` extend in three lines each — an editor resolves the nearest
  config by directory, and an inherited `include` resolves relative to where it was written.
  Neither is executed by `check` — Bun strips types without checking them — so they exist to make an
  editor right about which globals are in scope.

To **ship**: branch → PR (CI lints + tests, and comments a preview URL you can click) → merge to
your production branch (CI deploys). No manual `deploy` step in the normal loop — see below.

## Deploy

Deploys are **automatic**, via [Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/)
— Cloudflare's own Git CI, which the Deploy button connects to your fork for you. Merge to your
production branch and the Worker ships; open a PR and you get a preview URL. `bun run deploy` still
works for an out-of-band push.

### CI (dashboard: Worker → Settings → Builds)

The whole config lives in the Cloudflare dashboard — Workers Builds has no in-repo config file, so
what the button sets up is recorded here, both to check it and to rebuild it by hand:

| Setting | Value |
| --- | --- |
| Root directory (“Path”) | `/` (dashboard-relative; a subdirectory would be `/cdn`) |
| Build command | `bun run check` |
| Deploy command | `npx wrangler deploy` |
| Non-production branch deploy command | `npx wrangler versions upload` |
| Production branch | `master` |
| Builds for non-production branches | enabled |
| Build watch paths (include) | — (the whole repo; see below) |
| Build caching | enabled |

**Watch paths** matter only if you vendor this Worker into a larger repo. Mind that the two path
conventions differ, and the dashboard doesn't say so: the **root directory** is dashboard-relative
and leading-slashed (`/cdn`, matching Cloudflare's own `/workers/product-service/` example) while
**watch paths** are **repo-root**-relative and bare (`cdn/*`). Set the latter and commits touching
anything outside that subtree never trigger a build — which is what makes a Worker-in-a-monorepo
viable at all. (Cloudflare's `*` matches zero or more characters, `/` included, so `cdn/*` covers
`cdn/src/**` too.) A standalone fork wants neither.

**`bun run check`** (`package.json`) is the whole build: `bun install --frozen-lockfile && biome
check . && vitest run`. A red lint or a red test blocks the deploy — nothing reaches your
domain that wouldn't pass locally. Deliberately a *script*, not a `&&` chain typed
into the dashboard: what CI runs is then source-controlled, reviewable in a diff, runnable verbatim
on a laptop, and changing it never means editing the dashboard again. The dashboard holds one
stable string; the repo holds the meaning. (`--frozen-lockfile` also fails the build on a
`bun.lock` that drifted from `package.json`, which a local `bun install` would silently fix — note
`bun ci` does **not** do this. Despite the name it is not `npm ci`: it's a plain install that
happily accepts a drifted lockfile.)

**Always `bun run <script>`, never `bun <script>`.** Bun's builtins shadow same-named scripts
silently: `bun ci` runs an *install* and `bun test` runs *bun's* test runner — both exit 0 without
touching vitest or biome, which is why the script is `check` and not `ci`.

Build watch paths, caching, and the rest are only editable **after** the repo is connected (the
connect modal doesn't show them). Connecting does not build anything retroactively — the first
build needs a fresh commit.

### Zone settings (also dashboard-only)

One setting on the **zone**, not the Worker, is load-bearing for the caching policy and likewise
has no in-repo home, so it's recorded here too:

| Zone → Caching → Configuration | Value |
| --- | --- |
| Browser Cache TTL | **Respect Existing Headers** |

Cloudflare's default (4 hours) *overwrites* the `max-age` of any response served from cache, so the
Worker's `max-age=0` goes out as `max-age=14400` on every HIT — see Conventions. (Only applies once
the Worker is on a zone you own; a `workers.dev` deploy has no zone settings to get wrong.)

### Previews

A PR builds a **version** rather than a deployment: uploaded, addressable, but serving no traffic.
Cloudflare comments two URLs on the PR — a per-commit one, and a stable per-branch alias at
`<branch>-<worker>.<your-subdomain>.workers.dev` that survives further pushes to the branch. Both
need `"preview_urls": true` in `wrangler.jsonc` (it is on): preview URLs hang off the `workers.dev`
subdomain, which a Worker **gives up when it takes a custom domain**, so once you add a `routes`
entry the link resolves to a "preview URLs are disabled" page rather than the app unless you also
set `"workers_dev": true`. `bun run preview` uploads one by hand.

**A preview shares production's bindings.** Workers has no per-environment binding overrides, so a
preview version talks to the *live* R2 bucket with the *live* secrets — deliberate (an explorer
with an empty bucket tells you nothing), but it means the delete / move / rename APIs on a preview
URL hit real objects. The blast radius is bounded by what a version *cannot* do: it never answers
on your custom domain and it never runs the cron sweep — only the deployed version does. The
`CDN_PASSWORD` gate covers previews exactly as it covers prod.

### Secrets

Four, named in `.dev.vars.example`. The Deploy to Cloudflare button prompts for them; otherwise
they are one-time and shared by every version incl. previews: `wrangler secret put CDN_PASSWORD` /
`CDN_SESSION_SECRET` / `CDN_UPLOAD_TOKEN` / `CDN_PURGE_TOKEN`. Setting them by hand needs a first
deploy to exist. `CDN_UPLOAD_TOKEN` is a bearer *you* issue, not a Cloudflare credential — file it
in your password manager alongside app tokens, not cloud ones.

`CDN_PURGE_TOKEN` is optional, and the one real Cloudflare credential here. It must be an
**account-owned
token** (Manage Account → **Account API Tokens** → Create Token → Custom token), not a user token
from My Profile. The distinction matters: a user token acts on behalf of a person and inherits a
subset of *their* permissions, so it dies with the account membership — an account token is a
service principal with its own permissions, which is what a Worker that must keep purging for
years actually is. It also mints in the scannable `cfat_` format, so a leak into a repo or a log is
something credential scanners can *find*. (Cache is on the account-token compatibility matrix;
a handful of products — Page Rules, Turnstile, Registrar — still are not. Creating one needs Super
Administrator on the account.)

One permission, **Zone → Cache Purge → Purge** (permission group
`e17beae8b8cb423a99b1730f21238bed`), scoped to **your zone** and nothing else — so a leak buys an
attacker a cache purge and no more. Verified: it purges the zone, and a zone-settings read with it
is denied.

The zone id and public origin that go with it are plain `vars`, not secrets — the zone id is in
every dashboard URL and the public origin is the whole point of a CDN. They are **not** in
`wrangler.jsonc` by default, because a fresh deploy has neither; add them once you have a domain:

```jsonc
"vars": {
  "CDN_ZONE_ID": "<your zone id>",
  "CDN_PUBLIC_ORIGIN": "https://cdn.example.com"
},
```

Absent ⇒ local-POP purge only, which is a working configuration, not a broken one.

Two gotchas when handling the token:

- **It verifies at the account endpoint.** `GET /client/v4/user/tokens/verify` answers *"Invalid API
  Token"* for a perfectly good `cfat_` token — that route is for user tokens. Use
  `GET /client/v4/accounts/<account id>/tokens/verify`.
- **`wrangler secret put` fails while a preview version is the latest.** Every PR makes Workers
  Builds `versions upload`, and wrangler then refuses to edit secrets ("the latest version of your
  Worker isn't currently deployed") rather than silently promote that preview. Merge first, let the
  production build deploy, *then* put the secret. Don't work around it with `wrangler versions secret
  put` — that makes a hand-uploaded version the latest again and you hit the same guard next merge.

## Conventions

- Namespace by project (`myapp/`, `screenshots/`, …). Empty folders = a hidden `.keep` marker.
- Classify by **key extension only** (no content-type inference) — the CLI guarantees extensions.
- **Content-type is derived from the key on write *and* on serve** (`mimeFor`, `src/lib/cdn.ts`).
  Deriving again at serve time is a no-op for anything we stored — the upload already ignores the
  client's content-type — but it makes the MIME table *retroactive*: a change to it applies to
  every object already in the bucket, no metadata backfill, and objects that got into R2 by some
  other door (dashboard, `wrangler r2 object put`) are typed the same as ours — that retroactivity
  is why adding `.xml` (`application/xml`, so an appcast *reads* in a browser instead of prompting a
  download) fixed every appcast already in the bucket, Sparkle being indifferent either way since
  `SUAppcast` parses the raw bytes and never reads the header. Text-ish types
  (`text/*`, HTML, SVG, JSON, XML) carry **`; charset=utf-8`**: with no charset the browser guesses
  latin-1, and a shared `.md`/`.txt` renders every em-dash, arrow, `×` and box-drawing character
  as mojibake. Plain text has no in-band way to declare its encoding — no `<meta>`, no XML prolog
  — so the header is the only place it can be said.
- Move/rename change the key → **the public URL changes**; the UI confirms.
- **Expiry** lives in the Worker, not R2: a daily cron (`triggers.crons`) runs `sweep()`, deleting
  objects >30 days after upload **unless flagged `permanent`** (R2 customMetadata). The bucket's
  old blanket 30d lifecycle rule is gone (R2 rules are prefix-only — no per-object exemptions);
  only the multipart-abort rule remains on the bucket. Flag at upload (`?permanent=1` on the write,
  `?permanent=1`) or toggle in the UI (∞ badge, `is:permanent` search); overwrites keep the flag.
- **Caching**: one policy for every key — `max-age=0, s-maxage=3600`. Browsers revalidate each
  view (If-None-Match → a cheap 304; the edge answers conditionals even on cache hits) while each
  edge POP caches the bytes an hour. (Formerly `max-age=86400`: a day of *browser* cache meant an
  overwritten key looked stale until the client cache-busted — the `.xml` special case died with it.)
- **A write purges the URL globally.** Two mechanisms, because neither is enough alone: the Cache
  API (`caches.default.delete`) clears the POP the Worker ran in, and Cloudflare's **zone purge
  API** clears every other one. Before the second half existed the promise was only "fresh where you
  uploaded from, ≤1h everywhere else", which is fine for a screenshot link and wrong for a release
  feed: an OTA client anywhere else read an hour-old `appcast.xml`, and — worse — could pair a
  *fresh* appcast with the *stale* bytes of the stable `*-latest.zip` key, which fails Sparkle's
  signature check rather than merely looking old. A failed purge logs and does **not** fail the
  write (the bytes are already in R2; a lie there makes release scripts retry a successful upload).
  Needs `CDN_PURGE_TOKEN`; without it the Worker silently falls back to the local-POP-only
  behavior. The purge always names `CDN_PUBLIC_ORIGIN`, never the request's — a preview shares
  prod's bindings, so a preview upload mutates the live bucket and must invalidate the live domain.
- **The zone's Browser Cache TTL must stay on "Respect Existing Headers."** It is the one piece of
  this policy the Worker cannot enforce. Cloudflare rewrites `max-age` on any response served from
  cache, so with the dashboard default (4 hours) a `cf-cache-status: HIT` went out as
  `max-age=14400` no matter what the Worker set — silently undoing the `max-age=0` above for every
  client that honors Cache-Control. Caching → Configuration → Browser Cache TTL. To check:
  `curl -so /dev/null $U; curl -sD- -o /dev/null $U | grep -i 'cf-cache-status\|cache-control'` —
  a HIT must still say `max-age=0`. (Sparkle happens to be immune: `SPUDownloadDriver` fetches the
  appcast with `NSURLRequestReloadIgnoringLocalCacheData`. Browsers are not.)
- **Mutate through the Worker, not around it.** The cache purge lives in the Worker, so it only
  fires for writes that go through it (`/api/*`, the explorer, any uploader). Delete an object with
  `wrangler r2 object delete` or the R2 dashboard and the bytes vanish from R2 while the **public
  URL keeps serving a cached copy for up to an hour** — the folder page 404s but the object still
  200s, which looks like a ghost. Verified: same key with a `?cb=1` cache-buster 404s immediately.
  Use the explorer to delete; reach for wrangler only when you then don't mind the wait (or purge
  the URL by hand in the zone's Caching → Purge Custom URLs).

## Remaining

Nice-to-haves, not blockers: prefix-scoped TTLs (e.g. an ephemeral `24h/` namespace), a
multi-select bulk bar.

One operational note worth inheriting, learned the hard way on the instance this was extracted
from: **anything an installed app fetches on its own schedule must be uploaded `permanent`.** A
Sparkle appcast and its `*-latest.zip` sat untouched past the 30-day sweep and were deleted, so
copies of the app that hadn't checked in for months had nothing to update from. The flag is needed
once per key and sticks across later overwrites — set it on the first publish, not after.

## Open threads

Design work parked after the absolute-url arc (#28), captured here so it survives a fresh start —
these are *decisions/features not yet made*, distinct from the operational cleanup above.

1. **Agent-readable folder manifest.** Folder pages now emit absolute content URLs, so an
   HTML→markdown fetch (how an agent actually reads a link it's handed) yields usable file URLs in
   one hop — read the page once, fetch each file, no discovery round-trip. The exact-fidelity path
   is still open: content-negotiate the *same* folder URL — `Accept: application/json` (plus an
   explicit `?format=json` alias for fetchers that can't set the header) returns
   `{ type:"folder", url, files:[{ name, url, contentType, size, lastModified }], folders:[…] }`,
   a thin projection of `listFolder` — no new route. Deliberately **not** a
   `<script type="application/json">` / `<link rel="alternate">` / `Link:` header embed: all three
   are stripped by the markdown conversion agents use, so they never reach the reader (verified —
   the folder page's `<head>` and scripts don't survive; only the response body and visible
   text/hrefs do). Gated on thread 2.

2. **What's really public — and should roots be un-guessable?** The CDN is public by construction:
   anyone with `myapp/foo/1.png` can walk `myapp/` and every prefix below it via the folder
   pages (siblings + children are listed one level at a time). Top-level roots are only *semi*
   -invisible (guessable, not secret). Open question before shipping the JSON manifest — which
   makes enumeration trivial, i.e. effectively publishes a sitemap: decide what should be
   enumerable vs. not, and whether to anonymize / opaque-slug roots so a shared deep link can't
   leak collateral (other projects, internal structure). Until that's decided, two brakes stay in
   place: upward nav on the folder page (breadcrumbs, `..`) is kept **relative** on purpose — real
   URLs for a folder's own contents, not a frictionless machine path up toward the roots — and no
   machine manifest is published.

3. **Previews & rendering for the types that don't have them.** Today: **images** unfurl natively
   (the scraper GETs the bytes, `image/*` *is* the preview), **folders** unfurl via `<head>` meta →
   the takumi card (arc 2), and **video** is half — Slack/Discord sniff the content-type and embed a
   player, Twitter/iMessage want `og:video` meta the Worker doesn't emit. Everything else is
   link-only: **pdf, html, audio, code (js/json/css/xml/csv), text (txt/md/log), archives**. The
   files-with-no-preview set and the files-that-render-raw set are nearly the same set, which is why
   these got parked as one thread — but they are **two different asks**, and the distinction is the
   whole decision:

   - **A preview is additive.** og meta / a card is *about* the bytes; the bytes are untouched.
     Byte-exact serving, Range, direct download all survive.
   - **Rendering is transformative.** A pretty `.md` view means what a human sees at the URL is *not*
     the file — generated HTML replaced `text/plain` bytes. That collides with the contract at the
     top of this file (*"every other path streams the matching R2 object … range-capable"*) and with
     what a CDN link is understood to be. So rendering is not "a bigger preview"; it's a
     different question with a different blast radius.

   **The mechanism constraint that shapes the option space:** a raw non-HTML file has no `<head>`, so
   there is nowhere to attach og meta — a synthetic card for pdf/zip/audio can only reach a scraper
   by *intercepting* the request (branch on a known bot UA at the `/*` handler, serve a meta wrapper
   to Slackbot/Twitterbot/Discordbot/facebookexternalhit/iMessage, raw bytes to everyone else; how
   Dropbox/GitHub do it). HTML files *do* have a head, so they can be injected into directly, no
   UA-sniffing. And a **rendered viewer page has a head by construction** — which is the interesting
   coupling: if a renderable type gets a viewer, that page carries its own og card for free, and the
   two asks collapse into one artifact for those types.

   Option space for *where a rendered view lives*, if one is ever built (roughly increasing
   commitment): a **sibling URL** (`?view`, or a `/view/` route) leaving the canonical URL byte-exact;
   **content-negotiating the canonical URL** (`Sec-Fetch-Mode: navigate` → rendered, curl/Range → raw
   — elegant, but one-URL-two-representations, needs `Vary`/cache care, and surprises agents, cf.
   thread 1's finding about what survives markdown conversion); or **flipping what an uploader hands out**
   for renderable types, which changes the CLI's contract, not just the Worker's.

   For **html** specifically there's a fidelity ceiling worth recording: takumi is a fixed-node-tree
   layout renderer, not a browser — it cannot render arbitrary CSS/JS. A *faithful* thumbnail needs
   Cloudflare **Browser Rendering** (a real headless Chrome + a new binding, its own quota and cold
   start), which is the only heavyweight dependency anywhere in this thread. Separately floated and
   unresolved: serving self-contained HTML inside a phone-framed/contained chrome rather than
   full-bleed.

   Interactions to weigh before any of it: a bot-served card **leaks filename + kind for any key
   someone holds**, which is thread 2's question again; rendering user-bytes as HTML wants sanitizing
   (low risk while the bucket is only our own output); Browser Rendering must be pointed only at our
   own keys, never a supplied URL. Nothing here is decided — this is the map, not a plan.

## Recent arcs

Both post-#8 arcs have shipped: **arc 1** — server pages to `hono/jsx` (`src/folder.tsx`,
`src/login.tsx`, shared tokens in `src/lib/ui.ts`, zero new deps; the client explorer stayed
vanilla/zero-build — the streamed-shell boot and static skeleton are load-bearing, per the
single-paint rule above) — and **arc 2** — og:image unfurl cards (`src/card.ts` + the `/.og/`
route + meta on folder pages; raw file URLs already unfurled natively via content-type, folder
pages were the gap). Ideas deliberately left on the table: cards (or pretty file pages) for
non-visual file types like zips/logs — since expanded into **open thread 3** above; purging card
caches on write (today `max-age=300` just ages out — a stale card for ≤5 min is fine).
