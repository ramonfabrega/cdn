// Zone lookup, the cache setting, and the narrow purge token.
//
// Shapes read out of the API reference, with two gaps recorded honestly rather
// than guessed — see `browserCacheTtl` and `cachePurgeGroup` below. A wrong
// constant in this file is a zone-wide setting changed for every hostname on
// somebody's domain, or a token minted with the wrong permissions; neither is
// something to infer from memory.

import { type ApiResult, type CloudflareOptions, call } from "../cloudflare.ts";
import { zoneCandidates } from "./wrangler.ts";

export type Zone = { id: string; name: string };

const readZone = (value: unknown): Zone | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const id = Reflect.get(value, "id");
  const name = Reflect.get(value, "name");
  return typeof id === "string" && typeof name === "string" ? { id, name } : undefined;
};

/**
 * The zone that actually contains this hostname. Tries each candidate suffix
 * most-specific first and takes the first that exists, so `cdn.example.co.uk`
 * resolves without anyone shipping a public-suffix list — and a subdomain that
 * is a zone in its own right wins over its parent, which is correct: that is the
 * zone whose settings and purges apply.
 */
export async function findZone(
  cf: CloudflareOptions,
  host: string
): Promise<ApiResult<Zone | undefined>> {
  for (const name of zoneCandidates(host)) {
    const res = await call<unknown>(cf, "GET", `/zones?name=${encodeURIComponent(name)}`);
    // A failure here is worth surfacing rather than trying the next candidate:
    // it is almost always the token lacking Zone Read, and silently falling
    // through would report "no such zone" for a zone that is right there.
    if (!res.ok) return res;
    const found = (Array.isArray(res.result) ? res.result : [])
      .map(readZone)
      .find((z) => z?.name === name);
    if (found) return { ok: true, result: found };
  }
  return { ok: true, result: undefined };
}

/**
 * Read the zone's Browser Cache TTL.
 *
 * This setting is the one piece of the caching policy the Worker cannot enforce:
 * Cloudflare rewrites `max-age` on anything served from cache, so the dashboard
 * default of 4 hours silently undoes the Worker's own `max-age=0`.
 *
 * For a day this was read and never written, because which integer means the
 * dashboard's "Respect Existing Headers" is not documented anywhere — the schema
 * says only `minimum 0`, and every cache page describes the option as a dropdown
 * label. See `RESPECT_EXISTING_HEADERS` for what settled it.
 */
export async function browserCacheTtl(
  cf: CloudflareOptions,
  zoneId: string
): Promise<ApiResult<number | undefined>> {
  const res = await call<unknown>(cf, "GET", `/zones/${zoneId}/settings/browser_cache_ttl`);
  if (!res.ok) return res;
  return { ok: true, result: readTtl(res.result) };
}

const readTtl = (result: unknown): number | undefined => {
  const value =
    typeof result === "object" && result !== null ? Reflect.get(result, "value") : undefined;
  return typeof value === "number" ? value : undefined;
};

/**
 * The integer the API takes for the dashboard's "Respect Existing Headers".
 *
 * MEASURED, not believed. The docs do not publish the mapping, so it was read
 * off a zone already known to be set to that option in the dashboard:
 * `GET /zones/{id}/settings/browser_cache_ttl` answered `{"value": 0}`. That is
 * a single observation rather than a documented contract — but it is an
 * observation of exactly the question, which is more than the docs offer, and it
 * is why this constant is now safe to WRITE and not only to compare against.
 *
 * Keep in mind what it costs to be wrong here, because it has not changed: this
 * setting is ZONE-WIDE. Setting it does not only affect this CDN's hostname, it
 * affects browser caching for every other hostname on the domain. That is why
 * the step names the whole zone in what it reports, and why it would be a
 * mistake to quietly widen this function to any other zone setting.
 */
export const RESPECT_EXISTING_HEADERS = 0;

/**
 * Set the zone's Browser Cache TTL to "Respect Existing Headers".
 *
 * `PATCH /zones/{zone_id}/settings/browser_cache_ttl` with `{ value }` — the
 * per-setting edit endpoint, not the bulk one, so nothing else on the zone is in
 * the request at all. A caller that got here has already read the current value
 * and found it different; the response is read back so the verdict reports what
 * the zone now says rather than what was asked for.
 */
export async function setBrowserCacheTtl(
  cf: CloudflareOptions,
  zoneId: string,
  value: number = RESPECT_EXISTING_HEADERS
): Promise<ApiResult<number | undefined>> {
  const res = await call<unknown>(cf, "PATCH", `/zones/${zoneId}/settings/browser_cache_ttl`, {
    value,
  });
  if (!res.ok) return res;
  return { ok: true, result: readTtl(res.result) };
}

export type PermissionGroup = { id: string; name: string; scopes: string[] };

/** The two scope strings a permission group carries. A group is scoped to the
    account or to a zone, and several names exist in BOTH — see permissionGroup. */
export const ACCOUNT_SCOPE = "com.cloudflare.api.account";
export const ZONE_SCOPE = "com.cloudflare.api.account.zone";

/**
 * Resolve a permission group id by name AND scope, at runtime.
 *
 * Deliberately not a hardcoded id, and the docs agree: "We recommend using `id`
 * as the key for interacting with Cloudflare APIs; the permission `name` is
 * cosmetic and subject to change… To fetch all available permission groups and
 * their IDs, use the List permission groups endpoint." A constant here would be
 * a number nobody could check, which is exactly the class of thing this project
 * keeps refusing to ship.
 *
 * THE SCOPE IS NOT OPTIONAL, and that is not caution — it is measured. Listing
 * a real account on 2026-09-07 returned 389 groups, of which SEVEN names appear
 * twice, once zone-scoped and once account-scoped:
 *
 *   Access: Apps and Policies Read / Write / Revoke, Disable ESC Read / Write,
 *   Logs Read / Write
 *
 * A name-only `.find()` takes whichever the API happens to return first. For
 * `Cache Purge` that is harmless — it is unique, verified — but a token minted
 * against the wrong half of an ambiguous pair is a credential that looks right
 * and does not work, or works somewhere it should not. So ambiguity is an error
 * here, never a coin flip: a caller says which scope it means, and two matches
 * refuse rather than guess.
 */
export async function permissionGroup(
  cf: CloudflareOptions,
  accountId: string,
  name: string,
  scope: string
): Promise<ApiResult<PermissionGroup>> {
  const query = new URLSearchParams({ name });
  const res = await call<unknown>(
    cf,
    "GET",
    `/accounts/${accountId}/tokens/permission_groups?${query}`
  );
  if (!res.ok) return res;
  const groups = (Array.isArray(res.result) ? res.result : [])
    .map((g): PermissionGroup | undefined => {
      if (typeof g !== "object" || g === null) return undefined;
      const id = Reflect.get(g, "id");
      const groupName = Reflect.get(g, "name");
      const scopes = Reflect.get(g, "scopes");
      return typeof id === "string" && typeof groupName === "string"
        ? {
            id,
            name: groupName,
            scopes: Array.isArray(scopes) ? scopes.filter((v) => typeof v === "string") : [],
          }
        : undefined;
    })
    .filter((g): g is PermissionGroup => g !== undefined);

  // Exact name: the query parameter is a substring search, and "Cache Purge"
  // must not quietly become something merely similar.
  const named = groups.filter((g) => g.name === name);
  if (!named.length) {
    return {
      ok: false,
      error: `no permission group named "${name}" on this account (found: ${groups.map((g) => g.name).join(", ") || "none"})`,
    };
  }

  const scoped = named.filter((g) => g.scopes.includes(scope));
  const [only, ...rest] = scoped;
  if (!only) {
    return {
      ok: false,
      error: `permission group "${name}" exists but not with scope ${scope} (it has: ${named.flatMap((g) => g.scopes).join(", ") || "no scopes"})`,
    };
  }
  if (rest.length) {
    return {
      ok: false,
      error: `permission group "${name}" is ambiguous at scope ${scope} — ${[only, ...rest].map((g) => g.id).join(", ")} all match, so this cannot be resolved by name`,
    };
  }
  return { ok: true, result: only };
}

/** The name is exactly this, per the API-token permissions reference. */
export const CACHE_PURGE_GROUP = "Cache Purge";

export type TokenSummary = { id: string; name: string };

/** Existing account-owned tokens, so setup mints at most one.
    Filtered here rather than server-side: a changelog says `?name=` was added,
    the reference schema for this endpoint does not list it, and a filter that is
    silently ignored would make every run think no token exists and mint another. */
export async function listTokens(
  cf: CloudflareOptions,
  accountId: string
): Promise<ApiResult<TokenSummary[]>> {
  const res = await call<unknown>(cf, "GET", `/accounts/${accountId}/tokens`);
  if (!res.ok) return res;
  const tokens = (Array.isArray(res.result) ? res.result : [])
    .map((t): TokenSummary | undefined => {
      if (typeof t !== "object" || t === null) return undefined;
      const id = Reflect.get(t, "id");
      const name = Reflect.get(t, "name");
      return typeof id === "string" && typeof name === "string" ? { id, name } : undefined;
    })
    .filter((t): t is TokenSummary => t !== undefined);
  return { ok: true, result: tokens };
}

/**
 * Mint the purge token: account-owned, one permission, one zone.
 *
 * Account-owned rather than user-owned on purpose. A user token acts on behalf
 * of a person and dies with their account membership; a Worker that must keep
 * purging for years is a service principal, which is what an account token is.
 * It also mints in the scannable `cfat_` format, so a leak into a repo or a log
 * is something credential scanners can find.
 *
 * One permission and one zone, so a leak buys a cache purge and nothing else.
 */
export async function createPurgeToken(
  cf: CloudflareOptions,
  accountId: string,
  zoneId: string,
  groupId: string,
  name: string
): Promise<ApiResult<{ id: string; value: string }>> {
  const res = await call<unknown>(cf, "POST", `/accounts/${accountId}/tokens`, {
    name,
    policies: [
      {
        effect: "allow",
        resources: { [`com.cloudflare.api.account.zone.${zoneId}`]: "*" },
        permission_groups: [{ id: groupId }],
      },
    ],
  });
  if (!res.ok) return res;
  const id =
    typeof res.result === "object" && res.result !== null
      ? Reflect.get(res.result, "id")
      : undefined;
  const value =
    typeof res.result === "object" && res.result !== null
      ? Reflect.get(res.result, "value")
      : undefined;
  return typeof id === "string" && typeof value === "string"
    ? { ok: true, result: { id, value } }
    : {
        ok: false,
        error:
          "the token was created but its secret was not returned — it is only shown once, so delete it and re-run",
      };
}

/**
 * Verify a minted token against the ACCOUNT endpoint.
 *
 * The user endpoint (`/user/tokens/verify`) answers "Invalid API Token" for a
 * perfectly good `cfat_` token, which is the single most confusing thing about
 * account-owned tokens and has cost this project an afternoon before.
 */
export async function verifyToken(
  cf: CloudflareOptions,
  accountId: string
): Promise<ApiResult<unknown>> {
  return call(cf, "GET", `/accounts/${accountId}/tokens/verify`);
}
