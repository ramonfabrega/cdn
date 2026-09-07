# cdn — a personal CDN you deploy in one click

A Cloudflare Worker that *is* your CDN: every path streams an object from an
R2 bucket (public, cached, range-capable), the apex serves a gated explorer
(sunburst, folder rail, drag-anywhere upload, search grammar), folder prefixes
render as public listing pages with og:image cards, and one authenticated
`POST /api/upload` is the only write path. Companions: a `share` CLI for
sessions and scripts, Claude Code hooks that mirror artifacts and sent files,
and a macOS Shortcut for the hotkey / Finder path.

Seeded 2026-09-07 out of the author's dotfiles (`cdn/`, 49 commits since
2026-06-02, history carried over with `git subtree split`). The live personal
instance still deploys from that dotfiles copy until the cutover below; this
repo is the template that replaces it. Trail and private context live in the
author's lore wiki (`projects/cdn.md`), not here.

## Thesis

**The Worker is the product, the CLI is a projection, the hooks are optional.**
The code was already generic: at seed, the only instance-specific surface was
four brand strings and the wrangler config. Everything a second deployment
needs is a fork with its own `wrangler.jsonc`, which is exactly the model the
Deploy to Cloudflare button imposes. So the repo is a *template*: the
top-level config is the generic, button-ready one; an instance adds its
custom domain as one route line after the first deploy.

Phase 1 landed that (2026-09-07). The brand strings now come from the request
host (`brand()` in `src/lib/ui.ts`) and the config carries no `routes` and no
`vars` — so **nothing in this repo names a domain, and nothing should**. The
optional purge vars are read through `optionalVar()` rather than declared, and
`.dev.vars.example` + `package.json` `cloudflare.bindings` are what the button
prompts from.

Phases 2–4 landed the same day. The client half is `packages/cli/`: the `cdn`
CLI (incur), the two mirror hooks, and `src/hosts.ts` — the one reader of
`~/.config/cdn/hosts/<host>.env`. Nothing shells out: no CLI on disk, no PATH
patch, no password manager; they resolve a host and POST with fetch. `macos/` is
the same three lines in bash and curl, for a Mac with nothing installed.
**Which host is config, not code**: `CDN_HOST` in a Claude Code settings scope's
`env`. Do not add a directory→host map; the settings already resolve user →
project → local.

Who invokes what, measured on the author's instance: sessions and hooks make
most uploads; humans use the explorer's drop zone and the Shortcut; the CLI
by hand is rare. Build order follows that: Worker + button first, hosts file +
hooks second, curl-based Shortcut third, the incur CLI last.

## Locked decisions (2026-09-07; the conversation that made them is in the wiki)

- **Public repo, fork-per-deployment.** The button requires public; custom
  domains are not provisioned by it (the zone is the presser's), so the
  route is a documented post-deploy step, doable from code (`routes` with
  `custom_domain: true` — wrangler provisions DNS + cert on deploy).
- **Brand from the request host, not a var.** Folder pages already derive
  links from the request; the card, login, folder page and explorer shell do
  the same. Removing config, not adding it.
- **Hosts file, dotenv format, one per host.** `~/.config/cdn/hosts/<host>.env`
  (`CDN_TOKEN=…`), mode 0600, written by `auth login`. Three readers with
  different capabilities — a Bun CLI, a Bun hook, a bash script on a Mac with
  no jq — and dotenv is the format all three parse natively (wrangler's
  `.dev.vars` is already it). Env override: `CDN_HOST` / `CDN_TOKEN`.
  Precedence flags > env > hosts file (clig.dev).
- **Hooks read the hosts file and POST with fetch.** No subprocess, no PATH
  patching — the shell-out to the CLI existed only to share a token lookup.
  Namespaces `artifacts/` and `sent/` are hook conventions the Worker never
  knows about.
- **The Shortcut's script is bash + curl.** The upload API is one POST with a
  bearer, so the hotkey / Finder path needs no Bun and no CLI: import the
  Shortcut, drop one token file. macOS-only, shipped under `macos/`, optional.
- **The CLI is incur** (typed args/env, `--json`, `--llms`, `skills add`, CTAs
  on auth errors). Consequence: verbs, not a bare file argument —
  `up <file> [dest]`, `auth login|status`, `ls <prefix>`. Package name is the
  product; `share` is a personal alias.
- **Optional install of the hooks = a Claude Code plugin** shipped from this
  repo (hooks.json + the generated skill). Phase two, after the Worker and
  CLI have run for a second organization.
- **Nothing else added.** Hono + takumi stay the only runtime deps; no build
  step; Workers Builds is CI (`bun run check`); no config format beyond
  dotenv; no keychain dependency.

## Do not break the live instance

The author's production Worker deploys from `~/code/personal/dotfiles/cdn`
via Workers Builds, watch path `cdn/*`. **Do not edit, move or delete that
copy** from this repo's sessions. Nothing here reaches production until the
cutover, which is a deliberate, one-time, human-approved sequence:

1. Deploy this template as a *fresh* Worker + bucket + token through the
   button, exactly as a stranger would. That is the template's first test.
2. Run both. Copy the bucket (objects carry `customMetadata.permanent`; the
   copy must preserve it or the permanent set is re-flagged by hand; a copy
   resets upload time, so pause the sweep mid-copy).
3. Move the custom-domain route from the old config to the new, deploy,
   re-put the four secrets and the purge token on the new Worker.
4. Only then retire the dotfiles copy.

## Conventions

- **Repo shape**: the Worker is the ROOT (the Deploy button expects that);
  everything client-side — CLI, hooks, host resolution, generated skill — is
  `packages/cli/`, a bun workspace. `macos/` stays outside it: a human install,
  not a package. One repo for a two-sided contract on purpose; see DESIGN.md.
- Two runtimes, two runners: `src/` is workerd (vitest, local Miniflare R2),
  `packages/cli/` + `macos/` are Bun (`bun:test`). vitest is scoped to `src/**`
  in its config so it never sweeps up Bun code; `bun run check` runs both, so CI
  stays one command. Hermetic — no real R2, no network off the machine. `bun run
  test` never `bun test` (bun's own runner shadows the script and exits 0); the
  `bun test packages/cli macos` inside `check` is that runner on purpose.
- **The contract number.** `GET /api/auth` answers `{ contract: N }`; the client's
  `SUPPORTED_CONTRACTS` is its twin. Bump only for a change a current client
  cannot survive, and move both in one commit — `bun run check` is what proves
  they agree.
- **Cloudflare API shapes are looked up, not remembered.** Every path, body and
  selector in `packages/cli/src/setup/` came out of the API reference, and where
  a value could not be confirmed the code says so and declines rather than
  guessing (see `browserCacheTtl`). Permission groups resolve by NAME at runtime
  because the docs say ids are the stable key but publish none. If you add a
  call, verify it the same way.
- Boundary parsing, no casts; zod at the edges; `defined<T>()`-style
  optional handling over `as`.
- Read `README.md` for the architecture, the caching policy, the
  dashboard-only settings (Workers Builds, the bucket's lifecycle rule) and
  the purge-token recipe. Zone Browser Cache TTL was on that list until
  `cdn setup` learned to write it — the integer meaning "Respect Existing
  Headers" was measured off a zone known to be set that way, not guessed. Phase 1 rewrote its
  opening and its instance-specific passages; the author's operational log
  came out with them and lives in the wiki. It names no domain — keep it
  that way.
- Decision narrative goes in `docs/DESIGN.md`; this file carries only what
  every session needs.
