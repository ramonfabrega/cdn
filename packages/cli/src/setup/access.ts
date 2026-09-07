// The Zero Trust half of `cdn setup`: put Access in front of the explorer, and
// keep the upload bearer working underneath it.
//
// Every shape here was read out of Cloudflare's API reference rather than
// remembered — the selectors, the `decision` values, the destination types,
// where `aud` appears in the response — because a wrong guess in this file is a
// door that is open or a door that is shut, and neither announces itself.
//
// TWO applications, and the first one has two possible shapes:
//
//   the WORKER            → allow the people you named (default)
//     …or the hostname    → the same, for a Worker this token cannot resolve
//   the hostname + /api/upload → bypass, so machines keep writing
//
// The Worker-level application is the better of the two and the default,
// because Access attaches the policy to the Worker itself: "This automatically
// protects every domain associated with the Worker, including its routes,
// Custom Domains, `workers.dev` hostname, and previews." A hostname application
// protects the hostname you name and nothing else — which leaves the preview
// URLs of every deploy answering to the password alone, the gap the README's
// Previews section has described since phase 1.
//
// The bypass is what keeps every writer working. Access matches the most
// specific rule first — "Hostname or path-based Access: Applies first … Worker-
// level Access: Applies next … Account-level Worker Access: Applies last" — so a
// path-scoped bypass overrides both shapes of the first application. Without it,
// turning on Access breaks every hook, the CLI and the Shortcut at once: the
// bearer never gets to the Worker because Access answers first with a login page.

import { type ApiResult, type CloudflareOptions, call } from "../cloudflare.ts";

/** An `include` rule. `--access alice@example.com` is one person; `--access
    @example.com` is everyone with an address there. */
export const includeRule = (who: string): Record<string, unknown> =>
  who.startsWith("@") ? { email_domain: { domain: who.slice(1) } } : { email: { email: who } };

/** Matches everyone — the only sensible `include` for a bypass. */
export const EVERYONE = { everyone: {} };

export type AccessApp = {
  id: string;
  aud: string;
  domain: string;
  name?: string;
  /** What the application actually secures. Supersedes `domain` when present —
      it is how a Worker-level application says which Worker. */
  destinations: Destination[];
};

/** Only the two variants this file creates. The schema has seven; the rest
    (private CIDRs, MCP portals, whole-account Worker coverage) are not things a
    CDN's setup should be inventing on anyone's account. */
export type Destination =
  | { type: "worker"; worker_id: string }
  | { type: "public"; uri: string }
  | { type: string; [key: string]: unknown };

const readDestinations = (value: unknown): Destination[] => {
  const raw = Reflect.get(Object(value), "destinations");
  if (!Array.isArray(raw)) return [];
  return raw.filter((d): d is Destination => typeof Reflect.get(Object(d), "type") === "string");
};

const readApp = (value: unknown): AccessApp | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const id = Reflect.get(value, "id");
  const aud = Reflect.get(value, "aud");
  const domain = Reflect.get(value, "domain");
  if (typeof id !== "string" || typeof aud !== "string") return undefined;
  const name = Reflect.get(value, "name");
  return {
    id,
    aud,
    domain: typeof domain === "string" ? domain : "",
    destinations: readDestinations(value),
    ...(typeof name === "string" ? { name } : {}),
  };
};

/**
 * The application already covering this exact domain, if any. `exact=true`
 * matters: without it a search for `cdn.example.com` also matches the
 * `/api/upload` application, and setup would decide its own bypass app was the
 * explorer app and skip creating one.
 */
export async function findApp(
  cf: CloudflareOptions,
  accountId: string,
  domain: string
): Promise<ApiResult<AccessApp | undefined>> {
  const query = new URLSearchParams({ domain, exact: "true" });
  const res = await call<unknown>(cf, "GET", `/accounts/${accountId}/access/apps?${query}`);
  if (!res.ok) return res;
  const apps = Array.isArray(res.result) ? res.result : [];
  const match = apps.map(readApp).find((a) => a?.domain === domain);
  return { ok: true, result: match };
}

/**
 * The application already covering this Worker, if any.
 *
 * There is no query parameter for a destination — `domain`, `name` and `aud` are
 * the filters the list endpoint documents — so this reads the page and matches on
 * the destination itself. Matching on the Worker id rather than on the
 * application's name is the point: a renamed application still protects the
 * Worker, and a second one would be a duplicate rather than a fix.
 *
 * Deliberately does NOT count an `all_workers` destination as covering this
 * Worker. It does, in effect — but `worker` takes precedence over it, so the
 * account-wide policy is not necessarily the policy that was asked for, and
 * quietly accepting it would make `--access alice@example.com` a no-op.
 */
export async function findWorkerApp(
  cf: CloudflareOptions,
  accountId: string,
  workerId: string
): Promise<ApiResult<AccessApp | undefined>> {
  const query = new URLSearchParams({ per_page: "1000" });
  const res = await call<unknown>(cf, "GET", `/accounts/${accountId}/access/apps?${query}`);
  if (!res.ok) return res;
  const apps = Array.isArray(res.result) ? res.result : [];
  const match = apps
    .map(readApp)
    .find((a) =>
      a?.destinations.some((d) => d.type === "worker" && Reflect.get(d, "worker_id") === workerId)
    );
  return { ok: true, result: match };
}

export type AppSpec = {
  name: string;
  /** The hostname (and optionally path) the application secures. Omitted for a
      Worker-level application, which names a Worker instead — and which the
      reference's own example sends with no `domain` at all. */
  domain?: string;
  destinations?: Destination[];
  /** Inline policies. App-scoped "legacy" policies cannot be added to newly
      created applications any more; an app either references reusable policies
      by id or carries inline ones, and inline keeps setup to a single call. */
  policies: Record<string, unknown>[];
  sessionDuration?: string;
};

export async function createApp(
  cf: CloudflareOptions,
  accountId: string,
  spec: AppSpec
): Promise<ApiResult<AccessApp>> {
  const res = await call<unknown>(cf, "POST", `/accounts/${accountId}/access/apps`, {
    type: "self_hosted",
    name: spec.name,
    ...(spec.domain === undefined ? {} : { domain: spec.domain }),
    ...(spec.destinations === undefined ? {} : { destinations: spec.destinations }),
    ...(spec.sessionDuration ? { session_duration: spec.sessionDuration } : {}),
    policies: spec.policies,
  });
  if (!res.ok) return res;
  const app = readApp(res.result);
  return app
    ? { ok: true, result: app }
    : { ok: false, error: "Access created the application but returned no aud tag" };
}

/** Which shape of first application setup made. Reported, because the two do not
    cover the same surface and the difference is the preview URLs. */
export type AccessMode = "worker" | "hostname";

const allowPolicy = (who: string[]) => ({
  name: "cdn explorer — allowed people",
  decision: "allow",
  include: who.map(includeRule),
});

/** A Worker, as Access wants to be told about one: an immutable id, and the name
    the tree already knows it by. */
export type WorkerRef = { id: string; name: string };

/**
 * The Worker application: everyone you named gets in, on every hostname this
 * Worker answers on, including the preview URLs. The default.
 *
 * No `domain`: the reference's worked example for this exact call sends `type`,
 * `name`, `destinations` and `policies` and nothing else, and `destinations` is
 * documented as superseding the domain-shaped fields.
 */
export const workerApp = (worker: WorkerRef, who: string[]): AppSpec => ({
  name: `cdn explorer (${worker.name})`,
  destinations: [{ type: "worker", worker_id: worker.id }],
  sessionDuration: "24h",
  policies: [allowPolicy(who)],
});

/** The hostname application: the fallback, for a Worker whose id setup could not
    resolve. Covers the hostname it names and nothing else — notably not the
    preview URLs, which keep answering to the password. */
export const explorerApp = (host: string, who: string[]): AppSpec => ({
  name: `cdn explorer (${host})`,
  domain: host,
  sessionDuration: "24h",
  policies: [allowPolicy(who)],
});

/**
 * The upload application: a bypass on the write route, so the bearer keeps
 * working. This is not a hole — `/api/upload` has its own authentication that
 * predates Access and is stricter for a machine than a login page would be. What
 * it prevents is Access answering a script's POST with an HTML login page, which
 * is what "protect the hostname" does by default.
 *
 * In `worker` mode it also carries an explicit `public` destination naming the
 * same path. That is not decoration: precedence over a Worker-level application
 * is documented for the `public` destination type by name, and a bypass that
 * loses the race is a bypass that does nothing. In `hostname` mode both
 * applications are domain-shaped and there is no race to win, so the shape stays
 * exactly as it shipped.
 */
export const uploadBypassApp = (host: string, mode: AccessMode): AppSpec => ({
  name: `cdn upload bypass (${host})`,
  domain: `${host}/api/upload`,
  ...(mode === "worker"
    ? { destinations: [{ type: "public" as const, uri: `${host}/api/upload` }] }
    : {}),
  policies: [
    {
      name: "cdn upload — bearer authenticates, not Access",
      decision: "bypass",
      include: [EVERYONE],
    },
  ],
});

/**
 * The Worker's immutable id, from the name in wrangler.jsonc.
 *
 * `GET /accounts/{account_id}/workers/workers/{worker_id}`, whose path parameter
 * the reference documents as "Identifier for the Worker, which can be ID or
 * name" — so the name goes in and `id` ("Immutable ID of the Worker") comes back.
 * One call, no listing, no pagination, and no matching on a field whose meaning
 * has to be assumed.
 *
 * NOT the `tag` from `GET /workers/scripts`. That value is the same shape and
 * very probably the same UUID, but it is documented only as the identifier the
 * Builds API calls `external_script_id` — never as "the Worker's ID" — while
 * `worker_id` is documented as "The ID of the Cloudflare Worker to protect with
 * Access". Two fields that look alike is exactly the situation where a guess
 * protects nothing and says it protected everything.
 *
 * A Worker that isn't there is `undefined`, not an error: the account may hold it
 * under another name, and the caller's move is to fall back to a hostname
 * application rather than to stop.
 */
export async function findWorker(
  cf: CloudflareOptions,
  accountId: string,
  name: string
): Promise<ApiResult<WorkerRef | undefined>> {
  const path = `/accounts/${accountId}/workers/workers/${encodeURIComponent(name)}`;
  const res = await call<unknown>(cf, "GET", path);
  if (!res.ok) return res.status === 404 ? { ok: true, result: undefined } : res;
  const id = Reflect.get(Object(res.result), "id");
  if (typeof id !== "string" || !id) {
    return { ok: false, error: `the Workers API answered for ${name} but named no id` };
  }
  const returned = Reflect.get(Object(res.result), "name");
  return { ok: true, result: { id, name: typeof returned === "string" ? returned : name } };
}

export type Organization = { authDomain: string; name?: string };

/**
 * The Zero Trust organization — the `<team>.cloudflareaccess.com` domain every
 * Access login goes through, and the `team` half of what the Worker needs to
 * verify an assertion.
 *
 * Returns `undefined` when the account has none. What the API answers in that
 * case is NOT documented, so this treats any failure to read one as "there
 * isn't one" and lets the caller decide — which is safe, because the caller's
 * move either way is to report it rather than to guess a team name.
 */
export async function getOrganization(
  cf: CloudflareOptions,
  accountId: string
): Promise<Organization | undefined> {
  const res = await call<unknown>(cf, "GET", `/accounts/${accountId}/access/organizations`);
  if (!res.ok) return undefined;
  const authDomain =
    typeof res.result === "object" && res.result !== null
      ? Reflect.get(res.result, "auth_domain")
      : undefined;
  if (typeof authDomain !== "string" || !authDomain) return undefined;
  const name =
    typeof res.result === "object" && res.result !== null
      ? Reflect.get(res.result, "name")
      : undefined;
  return { authDomain, ...(typeof name === "string" ? { name } : {}) };
}

export async function createOrganization(
  cf: CloudflareOptions,
  accountId: string,
  authDomain: string,
  name: string
): Promise<ApiResult<unknown>> {
  return call(cf, "POST", `/accounts/${accountId}/access/organizations`, {
    auth_domain: authDomain,
    name,
  });
}

/** `acme.cloudflareaccess.com` → `acme`, which is what the Worker's
    CDN_ACCESS_TEAM wants and what the certs URL is built from. */
export const teamOf = (authDomain: string) => authDomain.replace(/\.cloudflareaccess\.com$/, "");
