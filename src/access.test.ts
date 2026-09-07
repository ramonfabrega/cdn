// Access JWT verification, tested against a real RS256 signature.
//
// The keypair is generated here and the certs endpoint is stubbed, so this is not
// a mock of verification — it is verification, over bytes actually signed. That
// matters more than usual: every failure mode below (wrong audience, wrong
// issuer, expired, `alg` swapped) is a way an attacker gets in if the check is
// wrong, and a test that stubbed the verifier would pass while the door stood
// open.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { forgetAccessKeys, verifyAccessJwt } from "./access.ts";

const TEAM = "acme";
const AUD = "aud-tag-abc123";
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const CERTS = `${ISS}/cdn-cgi/access/certs`;

const b64url = (bytes: ArrayBuffer | Uint8Array) => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const encodeJson = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));

type Signer = {
  kid: string;
  jwk: JsonWebKey;
  sign: (header: object, payload: object) => Promise<string>;
};

const makeSigner = async (kid: string): Promise<Signer> => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    kid,
    jwk: { ...jwk, kid, alg: "RS256", use: "sig" },
    async sign(header, payload) {
      const head = encodeJson({ alg: "RS256", kid, typ: "JWT", ...header });
      const body = encodeJson(payload);
      const sig = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(`${head}.${body}`)
      );
      return `${head}.${body}.${b64url(sig)}`;
    },
  };
};

let signer: Signer;
const now = 1_800_000_000;
const goodClaims = { iss: ISS, aud: [AUD], exp: now + 600, email: "someone@example.com" };

/** The certs endpoint, stubbed. Counts calls so the caching and the
    refetch-on-unknown-kid behaviour are observable. */
const stubCerts = (keys: JsonWebKey[], status = 200) => {
  const calls = { n: 0 };
  const real = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url !== CERTS) return real(input, init);
    calls.n++;
    if (status >= 400) return new Response("nope", { status });
    return Response.json({ keys });
  });
  return calls;
};

beforeEach(async () => {
  forgetAccessKeys();
  signer = await makeSigner("k1");
});
afterEach(() => {
  vi.unstubAllGlobals();
  forgetAccessKeys();
});

describe("verifyAccessJwt", () => {
  test("accepts a token this team actually signed, and reads the email", async () => {
    stubCerts([signer.jwk]);
    const token = await signer.sign({}, goodClaims);
    expect(await verifyAccessJwt({ team: TEAM, aud: AUD }, token, { now })).toEqual({
      ok: true,
      email: "someone@example.com",
    });
  });

  // Access sits in front of the door; the header is only evidence if the
  // signature holds. A Worker that skips this trusts anyone who can set a header.
  test("rejects a token signed by someone else's key", async () => {
    const impostor = await makeSigner("k1"); // same kid, different key
    stubCerts([signer.jwk]);
    const token = await impostor.sign({}, goodClaims);
    expect(await verifyAccessJwt({ team: TEAM, aud: AUD }, token, { now })).toEqual({
      ok: false,
      reason: "bad signature",
    });
  });

  test("rejects a valid token issued for a different application", async () => {
    stubCerts([signer.jwk]);
    const token = await signer.sign({}, { ...goodClaims, aud: ["some-other-app"] });
    expect(await verifyAccessJwt({ team: TEAM, aud: AUD }, token, { now })).toEqual({
      ok: false,
      reason: "wrong audience",
    });
  });

  test("rejects a valid token from a different team", async () => {
    stubCerts([signer.jwk]);
    const token = await signer.sign(
      {},
      { ...goodClaims, iss: "https://evil.cloudflareaccess.com" }
    );
    expect(await verifyAccessJwt({ team: TEAM, aud: AUD }, token, { now })).toEqual({
      ok: false,
      reason: "wrong issuer",
    });
  });

  test("rejects an expired token, and one that isn't valid yet", async () => {
    stubCerts([signer.jwk]);
    const expired = await signer.sign({}, { ...goodClaims, exp: now - 1 });
    expect(await verifyAccessJwt({ team: TEAM, aud: AUD }, expired, { now })).toEqual({
      ok: false,
      reason: "expired",
    });
    const early = await signer.sign({}, { ...goodClaims, nbf: now + 60 });
    expect(await verifyAccessJwt({ team: TEAM, aud: AUD }, early, { now })).toEqual({
      ok: false,
      reason: "not yet valid",
    });
  });

  // The classic JWT footgun: trusting the header's `alg`. `none` and an HMAC
  // forged with the public key both live down that road.
  test("refuses any algorithm but RS256, even with a real signature attached", async () => {
    stubCerts([signer.jwk]);
    // The attack shape: a token this team really signed, with `alg` rewritten to
    // something the verifier might handle more leniently. A verifier that reads
    // `alg` from the token instead of pinning it is the vulnerability.
    const swapped = await signer.sign({ alg: "none" }, goodClaims);
    expect(await verifyAccessJwt({ team: TEAM, aud: AUD }, swapped, { now })).toEqual({
      ok: false,
      reason: "unexpected alg",
    });
    const hs256 = await signer.sign({ alg: "HS256" }, goodClaims);
    expect(await verifyAccessJwt({ team: TEAM, aud: AUD }, hs256, { now })).toEqual({
      ok: false,
      reason: "unexpected alg",
    });
    // And the unsigned form, which is what `alg: none` normally arrives as.
    const header = encodeJson({ alg: "none", kid: "k1", typ: "JWT" });
    expect(
      (
        await verifyAccessJwt({ team: TEAM, aud: AUD }, `${header}.${encodeJson(goodClaims)}.`, {
          now,
        })
      ).ok
    ).toBe(false);
  });

  test("a single-string aud is accepted, not just the array form", async () => {
    stubCerts([signer.jwk]);
    const token = await signer.sign({}, { ...goodClaims, aud: AUD });
    expect((await verifyAccessJwt({ team: TEAM, aud: AUD }, token, { now })).ok).toBe(true);
  });

  test("garbage is rejected without reaching the certs endpoint", async () => {
    const calls = stubCerts([signer.jwk]);
    expect(await verifyAccessJwt({ team: TEAM, aud: AUD }, "not-a-jwt", { now })).toEqual({
      ok: false,
      reason: "not a JWT",
    });
    expect(calls.n).toBe(0);
  });

  test("keys are cached, so a busy explorer isn't one subrequest per page", async () => {
    const calls = stubCerts([signer.jwk]);
    const token = await signer.sign({}, goodClaims);
    await verifyAccessJwt({ team: TEAM, aud: AUD }, token, { now });
    await verifyAccessJwt({ team: TEAM, aud: AUD }, token, { now });
    expect(calls.n).toBe(1);
  });

  // What a key rotation looks like from in here: a kid the cached set doesn't
  // have. One refetch, then a decision — rotation costs a fetch, not an outage.
  test("an unknown kid forces one refetch before it is a failure", async () => {
    const calls = stubCerts([signer.jwk]);
    await verifyAccessJwt({ team: TEAM, aud: AUD }, await signer.sign({}, goodClaims), { now });
    expect(calls.n).toBe(1);

    const rotated = await makeSigner("k2");
    vi.unstubAllGlobals();
    const after = stubCerts([signer.jwk, rotated.jwk]);
    const token = await rotated.sign({}, goodClaims);
    expect((await verifyAccessJwt({ team: TEAM, aud: AUD }, token, { now })).ok).toBe(true);
    expect(after.n).toBe(1);
  });

  test("an unreachable certs endpoint is a reason, not a throw", async () => {
    stubCerts([], 503);
    const token = await signer.sign({}, goodClaims);
    const res = await verifyAccessJwt({ team: TEAM, aud: AUD }, token, { now });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.reason).toContain("certs unavailable");
  });
});
