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

- Bun-first (`Bun.file`, `bun:test` where not in workerd), biome, vitest in
  workerd against a local Miniflare R2 — hermetic, no real R2 in tests.
  `bun run check` is what CI runs; `bun run test` never `bun test` (bun's own
  runner shadows the script and exits 0).
- Boundary parsing, no casts; zod at the edges; `defined<T>()`-style
  optional handling over `as`.
- Read `README.md` for the architecture, the caching policy, the
  dashboard-only settings (Workers Builds, zone Browser Cache TTL, the
  bucket's lifecycle rule) and the purge-token recipe. It predates the
  template turn and still says the author's domain in places; the template
  pass rewrites those sections, it does not delete them.
- Decision narrative goes in `docs/DESIGN.md` (create on the first real
  decision); this file carries only what every session needs.
