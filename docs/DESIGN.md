# Design notes

Why things are the way they are. `CLAUDE.md` carries what every session needs;
this file carries the decisions that were arguable, with the evidence that
settled them. Newest first.

## Setup generates the credential it used to ask for (2026-09-07)

`CDN_UPLOAD_TOKEN` is the bearer every writer uses — the CLI, both hooks, the
Shortcut. It used to be a thing you produced (`openssl rand -hex 32`), pasted
into a deploy dialog, and then pasted again into `cdn auth login`. Now setup
generates it, sets it, and stores it, and the two paste steps are gone.

That is the same argument as the deploy dialog one above, applied one layer
along: **asking a person for high-entropy input is a design smell, not a
security measure.** The value has no meaning to anybody — it is not chosen, not
remembered, not typed twice. Every place that asks for one is a place a
placeholder gets left behind.

**Never replacing an existing token is the load-bearing half.** Setup is
idempotent, so this step runs again on every re-run, and a token that already
exists is a token some other machine is already using — a hook on a laptop, a
Shortcut on a phone, a CI job. Overwriting it breaks all of them at once, and
breaks them silently: uploads start 401ing somewhere nobody is watching. So the
step reads `wrangler secret list` first, and an existing `CDN_UPLOAD_TOKEN` is
`present` with a pointer to `cdn auth login` for a machine that needs a copy.
Setup may create a missing credential. It may not replace a working one.

**Which forced the dry run to grow the same seam the API client already had.**
`recordingRunner` used to fake every command, so a dry run could not tell you
that `CDN_UPLOAD_TOKEN` already exists — it would promise to generate one on an
instance that has one, which is exactly the dry-run lie `readOnlyFetch` was
built to avoid. Reads now pass through to the real runner and writes are still
recorded. The read/write split is an explicit allowlist (`wrangler secret list`,
`wrangler whoami`) rather than a guess from the verb, because `secret list` and
`secret put` differ by one word and by everything.

**Stored unverified, on purpose, and that is a departure worth naming.**
`cdn auth login` verifies a token against `GET /api/auth` before writing it to
disk, because it is handed a token somebody else made and a wrong one on disk is
a confusing failure later. This token was generated here and set from here, so
the only thing a check could establish is whether DNS has propagated to the
custom domain setup may have created ninety seconds ago. That is not a reason to
withhold a credential we know is correct.

The one real failure mode is covered: if the secret lands on the Worker but the
local write fails — the mode check in `writeHostFile` refusing to leave a
world-readable token, say — the step fails loudly and says the secret is only
shown once, because at that point the value is genuinely gone and the fix is to
delete the secret and re-run rather than to hunt for it.

## master is production, and previews are the staging (2026-09-07)

This was true before it was decided — the dotfiles copy did it, and the template
inherited it — so it is written down now to stop it being settled by inertia.

**The shape:** `master` deploys to production. A branch gets a Workers Builds
preview URL. Per-PR preview *is* the staging environment; there is no third
place a change waits.

**Why it fits this project in particular.** The thing you compare a change
against is the live CDN, and a preview serves the *same R2 bucket* — so master
and a preview can be opened side by side on the same objects, and the only
difference between the two windows is the code. A separately-provisioned staging
environment would have an empty bucket, which for an explorer is not a weaker
test but a meaningless one: the whole surface is a rendering of what is in the
bucket.

**What that costs, and it is the same property.** The shared bindings that make
the comparison honest also mean a preview can *write*. Uploading, deleting,
moving or renaming from a preview mutates the live bucket, because Workers has
no per-environment binding overrides. Reading from a preview is free; acting in
one is production. The README's Previews section has always said so; it is worth
repeating here because this decision is what makes people spend time in previews.

**Consequence for a fork:** none, except that the button's default matches. A
fork that wants isolation gets it by pointing `bucket_name` at a different
bucket, which is one line — and gets an explorer full of nothing, which is the
trade it is choosing.

**And the press found the gap in this loop.** The README described the Workers
Builds settings as "what the button sets up". It was describing the *live
instance*, which was configured by hand. A real press leaves **Build command
empty** and sets **Deploy command to `bun run deploy`** — so a fresh fork deploys
every push without linting or testing it. The Worker works; the CI half of
"branch → PR → merge" simply is not there until someone turns it on.

`cdn setup` cannot turn it on either, and the reason is specific rather than
lazy: the Workers Builds API requires a **user-scoped** API token and explicitly
rejects account-scoped ones, while setup's token is account-scoped by design —
that being the whole point of a credential you can delete afterwards without
touching your user. So it stays a documented two-field dashboard step, and the
table now says what the button actually does next to what you should change it
to, which is what it should have said all along.

## The press, all the way through (2026-09-07)

The template deployed as a stranger would deploy it — button, dialog, build,
first login, first upload — on a throwaway Worker beside the live one. What it
settled:

**The button rewrites the Wrangler config and pushes it.** This was the last
thing no amount of reading resolved, and it mattered because `wrangler deploy`
takes the Worker's name from that file: a config still saying `cdn-explorer`
would have aimed a fresh deploy at the live Worker. Diffing the repo the button
created against this one, it changed exactly two lines and nothing else —

```diff
-  "name": "cdn-explorer",
+  "name": "cdn-explorer-test",
-  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "cdn" }],
+  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "cdn-test","preview_bucket_name": "cdn-test" }],
```

— taking both names from the setup form and adding a `preview_bucket_name` this
repo does not ship. The build log agrees: `Uploaded cdn-explorer-test` and
`env.BUCKET (cdn-test)`. So the names in `wrangler.jsonc` are DEFAULTS a presser
overrides in the form, exactly as the comment beside `bucket_name` claims, and
the config in the created repo stays consistent for every later build.

The form also validates the Worker name against the account's existing Workers —
typing a name already in use is rejected before anything is created — which is
the mechanism that makes the above safe rather than merely lucky.

**The one-field deploy works on real infrastructure.** In order, each step being
the first time that path had run anywhere:

- `/login` answered **200 with the password form**, not the 503 "not configured"
  page — so the single dialog field reached the Worker as a secret.
- Signing in worked with **no `CDN_SESSION_SECRET` on the Worker at all**, which
  is the derived-key path from the section above.
- A drag-and-drop upload succeeded with **no `CDN_UPLOAD_TOKEN` set**, through
  the cookie-authenticated route — the write path being closed to machines does
  not close it to a person.
- The object came back publicly at `200` with
  `content-type: text/plain; charset=utf-8` and
  `cache-control: public, max-age=0, s-maxage=3600`, the documented policy,
  from a Worker holding exactly one secret.
- The page titled itself `cdn-explorer-test · sign in` — `brand()` reading the
  request host, so a `workers.dev` deploy labels itself with no configuration.

**And it is a cheap loop to re-run.** Delete the repo and the bucket, press
again; nothing about the template holds state between attempts. That is worth
knowing because the remaining unknowns in this project are all of that shape —
things no document answers, that one press answers in four minutes.

## One field, and the two ways that went wrong (2026-09-07)

Found by pressing the button. The first real run of this template through the
Deploy to Cloudflare flow, done exactly as a stranger would, and the setup
dialog offered `change-me` in all four secret boxes.

**Cloudflare prefills the deploy dialog from `.dev.vars.example`'s VALUES.** The
docs say it in one line — "Add secrets to a `.dev.vars.example` or `.env.example`
file: `COOKIE_SIGNING_KEY=my-secret # comment`" — and the consequence is that a
placeholder in that file is a *default* in everybody's deploy dialog. This repo
shipped `change-me`. `CDN_PASSWORD=change-me` is embarrassing;
`CDN_SESSION_SECRET=change-me` is a compromise, because the session cookie is
signed with it and the value is printed in a public repository. Anyone could
forge `cdn_session=ok` and be inside the explorer — delete, move and rename
included — without ever seeing the login page.

**Checking that turned up the worse one, which had nothing to do with
`change-me`.** `sessionSecret` used to read:

```ts
env.CDN_SESSION_SECRET || `${env.CDN_PASSWORD ?? ""}::cdn-explorer-session`
```

With both unset it resolves to `"::cdn-explorer-session"` — again a constant in a
public repo. So the obvious fix, "ship the placeholders empty", would have left
a deployment that is *more* forgeable, not less. The comment above it claimed
auth failed closed; it did, on the password path, while the cookie path stood
open. **A fallback that cannot fail is not a fallback.** It now returns
`undefined`, and the gate treats that as "no cookie can be valid" rather than
inventing a key to check against. The regression test forges a cookie with the
published constant and expects a 401 — and, because a malformed forgery would
also produce a 401 and prove nothing, a positive control first proves the forger
makes cookies the Worker really does accept when the key is right.

**Then the interesting part: empty is safe but not good enough.** Empty fields
mean a stranger opens a terminal, runs `openssl rand -hex 32` twice, comes back
and pastes. As the author put it while looking at the dialog: *"if people have to
go to terminal to openssl and then back to browser they'll prolly leave
change-me's there."* That is right, and it is the actual defect behind the
`change-me` one — the flow asked for two values no human should ever be asked to
produce.

Cloudflare offers no help: `package.json` `cloudflare.bindings` supports
`description` and nothing else, with no way to mark a secret generated, required
or defaulted. So the only lever is **how many high-entropy values a human must
produce before the thing works**, and the answer should be zero.

- `CDN_PASSWORD` is required, and it is the one field a human is *good* at: a
  password input, which is exactly where a password manager offers to generate
  something strong.
- `CDN_SESSION_SECRET` is optional, and when absent the cookie key is derived
  from the password. That is the same derivation as before — its bug was the
  constant, not the idea.
- `CDN_UPLOAD_TOKEN` is optional, and absent is the *better* default: no machine
  write path at all, rather than one guarded by a value someone skimmed past. You
  can still upload by dragging onto the explorer, and `cdn setup` provisions the
  token when you want the CLI, the hooks or the Shortcut.
- `CDN_PURGE_TOKEN` was already minted by `cdn setup`.

So the first run is: type a password, deploy, log in. The trade-off is stated
rather than hidden — with no `CDN_SESSION_SECRET`, the cookie key is only as
strong as the password. That is not much of a concession: anyone able to
brute-force the key offline could hammer the login endpoint instead, and a
password field is where strong passwords come from.

**Simpler must not mean looser, so the looseness became loud.** The one state
that is genuinely broken — no password at all — now says so: `/login` renders a
"not configured" page with the one command that fixes it, and returns 503,
because the explorer is not misconfigured so much as not configured yet. The
alternative was a password box answering "Wrong password." to every possible
password, which is a lie about what is wrong and the kind of lie someone debugs
for twenty minutes.

Object serving deliberately keeps working in that state, and has its own test.
The two halves of this Worker have different failure modes on purpose: the
public CDN stays up (a fresh bucket is empty, and a secret momentarily lost
should not take everyone's links down), while the authenticated surface closes.
Fail closed on the door, not on the road.

**Then the second press measured the dialog, and half of that design was
wrong.** With the empty values shipped, the fields came up blank as intended —
and two things the documentation does not mention anywhere turned out to govern
everything:

1. **Every field is required.** Submitting an empty one produces the browser's
   own "Please fill out this field." There is no optional prompt. So "leave the
   other three blank" was not advice a presser could follow; it was a box they
   had to put *something* in, and whatever they typed would become a real
   credential on a real Worker. `CDN_PURGE_TOKEN` is the sharp end: it must be a
   genuine Cloudflare API token or the purge fails on every write.
2. **The secret fields arrived as four bare uppercase names**, with no
   descriptions, while the R2 bucket's description had rendered fine on the
   previous screen.

**That second observation was written up here as "descriptions do not render for
secrets", and the next press disproved it.** With one key in the file, the field
came up with its description rendered correctly above it. So the rule is not
"secrets have no descriptions"; something else made them vanish that once, and
the two candidates — the description then began with `**bold**` markdown, or the
dialog had a stale manifest — are both unconfirmed. Neither is stated as fact.
The entry stands as: *descriptions do render, and they went missing once under
conditions not yet pinned down.*

Recorded rather than quietly edited out, because the mistake is instructive and
is exactly the one this project keeps catching in other people's documentation: a
single observation written down as a rule. It survived twenty minutes. The
finding that did hold — every field is required — held because it was a
MECHANISM, the browser's own validation, rather than an ABSENCE. Absences are the
observations that most deserve a second look before they become sentences.

The required-ness alone leaves exactly one lever: **which keys appear in
`.dev.vars.example` at all.** So it now lists one, `CDN_PASSWORD`, and the other
three are comments. A commented key is not a field, the Worker treats all three
as absent, and absent is already the well-defined safe state — no bearer
accepted, no purge beyond the local POP, the cookie key derived from the
password. The dialog asks for one thing, that thing is genuinely required, and
nobody is asked to invent a Cloudflare API token to get past a form.

**The file is the form, so it is tested like one.**
`packages/cli/src/deploy-dialog.test.ts` asserts that exactly one key is
uncommented, that it is `CDN_PASSWORD`, that its value is empty, that the other
three are still *documented* while not being fields, and that every `env.CDN_*`
the Worker reads is accounted for somewhere in the file. This file has been
wrong twice in one day — `change-me` values, then three fields that could not be
left blank — and neither mistake was catchable by anything in the repo, because
nothing in the repo knew this file was a user interface. Now something does.

The general lesson is the one the whole day keeps repeating in different
costumes: **the docs did not say any of this, and pressing the button did.** The
prefill behaviour and the required-ness are two facts that shape the first
experience every stranger has of this project, neither documented, both cheap to
observe once someone ran the flow instead of reading about it — and the third
thing the press "found" turned out to be wrong, which is also what running the
flow is for.

**One more the press turned up, in the same form:** a *"Protect with Cloudflare
Access"* toggle. For this Worker it is a trap, because it protects the whole
thing — `POST /api/upload` included — so Access answers every script's upload
with a login page and the CLI, the hooks and the Shortcut break at once. That is
precisely the failure the bypass application exists to prevent, and the toggle
creates the protection without it. The README says to leave it off and run
`cdn setup --access`, which makes the same Worker-level application *and* the
path-scoped bypass. Setup also repairs it after the fact: `findWorkerApp` matches
the existing application by destination rather than by name, so it reports
`present` and the bypass step adds what is missing.

## The refusal that ended in a measurement (2026-09-07)

`cdn setup` sets Browser Cache TTL now. The interesting part is not the write —
it is four lines, exactly as predicted — but what it took to earn it, and what
did *not* change when it was earned.

**What the refusal was actually about.** The docs publish no mapping from the
dashboard's "Respect Existing Headers" to the integer the API takes; the schema
says `minimum 0` and stops. `0` was the widespread belief, and a widespread
belief is not a citation. The step therefore read and reported, and said in the
report why it was not writing — which is a different thing from omitting the
step, and is the whole reason the gap stayed visible long enough to be closed.

**What closed it was a measurement, not a better search.** The zone
`ramonfabrega.com` was already set to "Respect Existing Headers" in its
dashboard. So:

```sh
curl -s "https://api.cloudflare.com/client/v4/zones/$ZONE/settings/browser_cache_ttl" \
  -H "Authorization: Bearer $TOKEN" | jq '.result.value'
# 0        (modified_on 2026-09-04)
```

That is one observation, not a contract — and it is an observation of *exactly*
the question the docs decline to answer, taken from a zone whose dashboard state
was known independently. The constant in `zone.ts` carries that provenance in
its comment, because a bare `= 0` is precisely the unfalsifiable number this
project keeps refusing to ship. The read-only token that took the measurement
had one permission that mattered and was deleted after; the number is not
sensitive, and it never needed to be a credential in this repo.

**The zone-wide part did not go away, and is not the same objection.** The
original note gave the blast radius as the reason a *wrong* guess was
unacceptable. With the value right, the amplifier is gone — but a setup command
for one Worker still changes a setting that governs every hostname on the
domain, and that deserves to be said out loud rather than inferred later from
someone's cache behaviour. So the verdict names the ZONE, not the CDN's
hostname: "example.com now respects existing headers … this affects every
hostname on example.com, not only cdn.example.com". `--dry-run` says the same
sentence before anything happens. The step is automated; it is not silent.

**The write is `PATCH /zones/{zone_id}/settings/{setting_id}`** — "Updates a
single zone setting by the identifier", body `{ value }`, permission "Zone
Settings Write". The per-setting endpoint rather than the bulk one, so no other
zone setting is even present in the request; the response is read back and
compared, so the verdict reports what the zone now says rather than what was
asked for. A token with Zone Settings Read but not Write is the likely failure
and has its own test: it fails loudly and hands back the two clicks.

## Access protects the Worker, not a hostname (2026-09-07)

`cdn setup --access` used to create an Access application on the hostname you
gave it. It now creates one on the **Worker**, and the difference is everything
the Worker answers on that isn't that hostname: its routes, its Custom Domains,
its `workers.dev` hostname, and — the reason this was worth doing — its preview
URLs. A preview shares production's bindings, so before this it was the live
bucket behind a password and nothing else. The hostname application remains, as
a fallback, and setup says when it fell back to one.

**The finding this was chartered from was wrong in its most important word, and
re-reading the docs is what caught it.** It said `preview_worker` covers routes,
Custom Domains, workers.dev and previews in one application. It does not:
`preview_worker` covers *previews only*. The type that covers everything is
`worker` — "A specific Cloudflare Worker that Access will secure. All requests
routed to the specified Worker, including its preview deployments, will be
protected." Shipping the remembered version would have produced an application
that looked right in the dashboard and protected nothing anyone visits.

**`worker_id` is the Worker's id, and there are two 32-hex values it could be.**
`GET /workers/scripts` answers `{id: <name>, tag: <uuid>}`, and the Builds API
documents that `tag` as `external_script_id`. The Workers resource answers `id`,
documented as "Immutable ID of the Worker". The Access schema asks for "The ID
of the Cloudflare Worker to protect with Access". Only one of those is documented
as the Worker's ID, so setup asks
`GET /accounts/{id}/workers/workers/{worker_id}` — whose path parameter is
"Identifier for the Worker, which can be ID or name", so the name from
`wrangler.jsonc` goes in and the id comes back in one call. The two values are
probably the same UUID. "Probably" is how you ship an application that protects
a Worker nobody has.

**Not resolving the Worker is a fallback, not a failure.** A token without
Workers read, an account with nothing deployed yet, a Worker the account knows
by another name: in every one of those the hostname application is still exactly
what setup made before this, and it still works. What changes is the preview URLs,
so the step's detail says which shape it made and, when it fell back, why —
a checklist that reports the same sentence for two different outcomes is a
checklist that has stopped being one.

**The bypass had to learn to say `public` out loud.** Access resolves the most
specific rule first: "Hostname or path-based Access: Applies first … Worker-level
Access: Applies next … Account-level Worker Access: Applies last." The
`/api/upload` bypass is path-based, so it still wins — but the schema documents
precedence over a `worker` destination for the `public` destination *type* by
name, and the bypass had been carrying only the legacy `domain` field. Against a
Worker-level application it now carries both. In hostname mode nothing changed:
two domain-shaped applications, no race to win, and the shape that shipped is the
shape that stays.

**The Worker learned the other half.** Worker-level Access does not hand the
isolate a header to verify; it hands it `ctx.access` — "When Cloudflare Access
authenticates a request that directly invokes your Worker … No extra
configuration or JWT parsing is required", and "`ctx.access` is undefined if
Access did not authenticate the request". So the gate checks that first and the
assertion second. The asymmetry is deliberate and is the whole security argument:
the header is part of the request and anyone reaching the Worker another way can
set it, while `ctx.access` is set by the runtime and cannot be sent. The `aud`
comparison stays in both paths — it is what makes somebody else's Access
application not a key to this one. It is read structurally rather than through a
type, because `ctx.access` is newer than the `@cloudflare/workers-types` this
repo pins and a cast asserts something about the runtime instead of asking it.
It is also why that half is unit-tested: `SELF.fetch` runs the real runtime, and
the real runtime sets `ctx.access` only for a real Access application — there is
nothing a test can hand it, which is precisely the property being relied on.

**One documented reason to want the old shape, so there's a flag for it.**
Worker-level Access policies do not support WebSocket connections; an upgrade
request to a Worker protected that way gets a `403`. This Worker opens no
sockets, so the default is safe here — but a fork that adds them needs
`--access-hostname`, and a fork should not have to discover that from a `403`.

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

*Resolved the same day — it was four lines and a test. See "The refusal that
ended in a measurement" above.*

**It does not create a Zero Trust organization.** Creating one picks a permanent
team domain — `<name>.cloudflareaccess.com`, which then appears in every login
URL forever. That is a naming decision, and a setup command should not make one
on your behalf. It reports the absence and asks you to make it once.

Two more findings worth recording, both from reading the docs rather than
remembering them:

**Access for Workers IS API-drivable**, via `POST /accounts/{id}/access/apps`
with a `destinations` entry naming the Worker, and protecting a Worker that way
covers "routes, Custom Domains, `workers.dev` hostname, and previews" in one
application — which closes the preview gap the Previews section of the README
describes. Built hours later; see *Access protects the Worker, not a hostname*
above, which also corrects the destination type this paragraph first named.

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
WASM module is the kind of thing that eats that budget.

**Now measured, on a cold first deploy of a fresh Worker: `Worker Startup Time:
1 ms`.** One thousandth of the budget. So the concern was real but the answer is
not close — takumi's WASM is compiled by the runtime, not executed at global
scope, and the static import in `src/worker.ts` costs nothing measurable. If it
ever does change, the fix is to load the renderer inside the `/.og/*` handler
rather than to shrink the bundle. That limit would still bite long before 64 MiB
does; when something feels slow to cold-start, measure startup, not size.

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
