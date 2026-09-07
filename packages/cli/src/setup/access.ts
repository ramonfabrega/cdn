// The Zero Trust half of `cdn setup`: put Access in front of the explorer, and
// keep the upload bearer working underneath it.
//
// Every shape here was read out of Cloudflare's API reference rather than
// remembered — the selectors, the `decision` values, where `aud` appears in the
// response — because a wrong guess in this file is a door that is open or a door
// that is shut, and neither announces itself.
//
// TWO applications, not one:
//
//   the hostname          → allow the people you named
//   the hostname + /api/upload → bypass, so machines keep writing
//
// Access matches the most specific path, so the second wins for the upload route.
// Without it, turning on Access breaks every hook, the CLI and the Shortcut at
// once — the bearer never gets to the Worker because Access answers first with a
// login page. That is the failure this pair exists to prevent.

import { type ApiResult, type CloudflareOptions, call } from "../cloudflare.ts";

/** An `include` rule. `--access alice@example.com` is one person; `--access
    @example.com` is everyone with an address there. */
export const includeRule = (who: string): Record<string, unknown> =>
  who.startsWith("@") ? { email_domain: { domain: who.slice(1) } } : { email: { email: who } };

/** Matches everyone — the only sensible `include` for a bypass. */
export const EVERYONE = { everyone: {} };

export type AccessApp = { id: string; aud: string; domain: string; name?: string };

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

export type AppSpec = {
  name: string;
  domain: string;
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
    domain: spec.domain,
    ...(spec.sessionDuration ? { session_duration: spec.sessionDuration } : {}),
    policies: spec.policies,
  });
  if (!res.ok) return res;
  const app = readApp(res.result);
  return app
    ? { ok: true, result: app }
    : { ok: false, error: "Access created the application but returned no aud tag" };
}

/** The explorer application: everyone you named gets in, nobody else does. */
export const explorerApp = (host: string, who: string[]): AppSpec => ({
  name: `cdn explorer (${host})`,
  domain: host,
  sessionDuration: "24h",
  policies: [
    { name: "cdn explorer — allowed people", decision: "allow", include: who.map(includeRule) },
  ],
});

/**
 * The upload application: a bypass on the write route, so the bearer keeps
 * working. This is not a hole — `/api/upload` has its own authentication that
 * predates Access and is stricter for a machine than a login page would be. What
 * it prevents is Access answering a script's POST with an HTML login page, which
 * is what "protect the hostname" does by default.
 */
export const uploadBypassApp = (host: string): AppSpec => ({
  name: `cdn upload bypass (${host})`,
  domain: `${host}/api/upload`,
  policies: [
    {
      name: "cdn upload — bearer authenticates, not Access",
      decision: "bypass",
      include: [EVERYONE],
    },
  ],
});

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
