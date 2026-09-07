// Cloudflare Access as a way in, alongside the password.
//
// When Access sits in front of the explorer it authenticates the visitor before
// the request ever reaches us and injects a signed assertion. Verifying that
// assertion is the whole of this file — and verifying it is not optional: Access
// only guards the front door, so a Worker that trusts the header without checking
// the signature trusts anyone who can set a header.
//
// What this buys a team instance: no shared secret. `CDN_PASSWORD` is one string
// that everyone knows and nobody rotates; Access is per-person, revocable, and
// audited, with the identity provider you already run. The password stays as the
// fallback — a solo install shouldn't need Zero Trust, and a preview URL outside
// the Access application still has to be reachable.
//
// Shape verified against Cloudflare's docs rather than remembered:
//   certs   https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
//   alg     RS256
//   claims  aud (the application's AUD tag), iss (the team domain), exp
//   and: match the token's `kid` against `public_certs` rather than using the
//   single `public_cert`, which is what makes key rotation survivable.

const base64urlToBytes = (s: string): Uint8Array => {
  const padded = s.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
};

const decodeJson = (segment: string): unknown => {
  try {
    return JSON.parse(new TextDecoder().decode(base64urlToBytes(segment)));
  } catch {
    return null;
  }
};

const str = (o: unknown, k: string): string | undefined => {
  const v = typeof o === "object" && o !== null ? Reflect.get(o, k) : undefined;
  return typeof v === "string" ? v : undefined;
};

const num = (o: unknown, k: string): number | undefined => {
  const v = typeof o === "object" && o !== null ? Reflect.get(o, k) : undefined;
  return typeof v === "number" ? v : undefined;
};

/** `aud` is a string or an array of them, per the JWT spec, and Access uses the
    array form. Normalize before comparing so a single-audience token isn't
    silently rejected. */
const audiences = (payload: unknown): string[] => {
  const raw = typeof payload === "object" && payload !== null ? Reflect.get(payload, "aud") : null;
  if (typeof raw === "string") return [raw];
  if (Array.isArray(raw)) return raw.filter((a): a is string => typeof a === "string");
  return [];
};

export type AccessConfig = { team: string; aud: string };
export type AccessResult = { ok: true; email?: string } | { ok: false; reason: string };

// The signing keys change; refetching them per request would add a subrequest to
// every page load. Cached per team in the isolate, with a short TTL and a forced
// refetch when a `kid` is unknown — which is exactly what a rotation looks like
// from here, so rotation costs one extra fetch rather than an outage.
type Jwks = { keys: unknown[]; fetchedAt: number };
const JWKS_TTL_MS = 60 * 60 * 1000;
const jwksCache = new Map<string, Jwks>();

const teamOrigin = (team: string) =>
  `https://${team.replace(/^https?:\/\//, "").replace(/\.cloudflareaccess\.com$/, "")}.cloudflareaccess.com`;

const fetchJwks = async (team: string, doFetch: typeof fetch): Promise<unknown[]> => {
  const res = await doFetch(`${teamOrigin(team)}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`certs ${res.status}`);
  const body: unknown = await res.json();
  const keys = typeof body === "object" && body !== null ? Reflect.get(body, "keys") : null;
  return Array.isArray(keys) ? keys : [];
};

const keysFor = async (team: string, doFetch: typeof fetch, force: boolean): Promise<unknown[]> => {
  const cached = jwksCache.get(team);
  if (!force && cached && Date.now() - cached.fetchedAt < JWKS_TTL_MS) return cached.keys;
  const keys = await fetchJwks(team, doFetch);
  jwksCache.set(team, { keys, fetchedAt: Date.now() });
  return keys;
};

/** Exported for tests: an isolate that has already cached a team's keys would
    otherwise carry them between cases. */
export const forgetAccessKeys = () => jwksCache.clear();

const importKey = (jwk: unknown) =>
  crypto.subtle.importKey(
    "jwk",
    // A JWK is a plain object with string fields; workerd validates it far more
    // strictly than any check here would.
    JSON.parse(JSON.stringify(jwk)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );

/**
 * Verify an Access assertion. Returns a reason rather than throwing, because the
 * caller's next move is the same either way — fall back to the password gate —
 * and a reason is worth a log line.
 *
 * `now` is injectable so a test can prove expiry is actually checked without
 * sleeping.
 */
export async function verifyAccessJwt(
  config: AccessConfig,
  token: string,
  options: { fetch?: typeof fetch; now?: number } = {}
): Promise<AccessResult> {
  const { fetch: doFetch = globalThis.fetch, now = Date.now() / 1000 } = options;

  const parts = token.split(".");
  const [rawHeader, rawPayload, rawSignature] = parts;
  if (parts.length !== 3 || !rawHeader || !rawPayload || !rawSignature) {
    return { ok: false, reason: "not a JWT" };
  }

  const header = decodeJson(rawHeader);
  // Only RS256. Accepting whatever `alg` says is the classic JWT footgun — `none`
  // and an HMAC forged with the public key both live down that road.
  if (str(header, "alg") !== "RS256") return { ok: false, reason: "unexpected alg" };
  const kid = str(header, "kid");
  if (!kid) return { ok: false, reason: "no kid" };

  const payload = decodeJson(rawPayload);
  if (!payload) return { ok: false, reason: "unreadable payload" };

  // Claims BEFORE crypto: they are free, and a token that fails them would fail
  // anyway. Checking the signature first only spends time on tokens we reject.
  const iss = str(payload, "iss");
  if (iss !== teamOrigin(config.team)) return { ok: false, reason: "wrong issuer" };
  if (!audiences(payload).includes(config.aud)) return { ok: false, reason: "wrong audience" };
  const exp = num(payload, "exp");
  if (exp === undefined || exp <= now) return { ok: false, reason: "expired" };
  const nbf = num(payload, "nbf");
  if (nbf !== undefined && nbf > now) return { ok: false, reason: "not yet valid" };

  const signed = new TextEncoder().encode(`${rawHeader}.${rawPayload}`);
  const signature = base64urlToBytes(rawSignature);

  for (const force of [false, true]) {
    let keys: unknown[];
    try {
      keys = await keysFor(config.team, doFetch, force);
    } catch (e) {
      return { ok: false, reason: `certs unavailable: ${e instanceof Error ? e.message : e}` };
    }
    const jwk = keys.find((k) => str(k, "kid") === kid);
    // An unknown kid on the cached set is what a key rotation looks like from
    // here; refetch once before deciding it is a bad token.
    if (!jwk) {
      if (!force) continue;
      return { ok: false, reason: "unknown signing key" };
    }
    let valid: boolean;
    try {
      valid = await crypto.subtle.verify(
        "RSASSA-PKCS1-v1_5",
        await importKey(jwk),
        signature,
        signed
      );
    } catch {
      return { ok: false, reason: "malformed signing key" };
    }
    return valid
      ? { ok: true, email: str(payload, "email") }
      : { ok: false, reason: "bad signature" };
  }
  return { ok: false, reason: "unknown signing key" };
}
