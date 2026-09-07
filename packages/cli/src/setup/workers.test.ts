// The Worker's account and secrets, over the API.
//
// These three calls replaced three shell-outs to `wrangler`, and the reason is
// worth keeping in a test rather than only in a comment: wrangler prefers
// CLOUDFLARE_API_TOKEN over its stored login, so passing the setup token to a
// child process silently replaced the credential those steps were documented to
// use. One credential, one place to authorize it, one place to look when it is
// refused.

import { describe, expect, test } from "bun:test";

import type { CloudflareOptions } from "../cloudflare.ts";
import { putSecret, resolveAccount, secretNames } from "./workers.ts";

type Seen = { method: string; path: string; body: unknown };

/** A Cloudflare that answers one payload and records what it was asked. The
    envelope is real, because `call` treats `success` and not the status as the
    answer, and a stub without it would let that regress. */
const stub = (payload: unknown, seen: Seen[] = [], status = 200) => {
  const cf: CloudflareOptions = {
    token: "setup-token",
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      seen.push({
        method: (init?.method ?? "GET").toUpperCase(),
        path: url.pathname.replace("/client/v4", ""),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(
        JSON.stringify({ success: status < 400, errors: [], messages: [], result: payload }),
        { status }
      );
    }) as typeof globalThis.fetch,
  };
  return { cf, seen };
};

describe("resolveAccount", () => {
  test("one account is the answer", async () => {
    const { cf, seen } = stub([{ id: "acc123", name: "Someone's Account" }]);
    const res = await resolveAccount(cf);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toEqual({ id: "acc123", name: "Someone's Account" });
    expect(seen[0]).toMatchObject({ method: "GET", path: "/accounts" });
  });

  // The one that matters. Picking the first would configure a stranger's zone as
  // readily as your own, and every verdict in the report would name an account
  // the person never chose.
  test("more than one is an error naming them, never a guess", async () => {
    const { cf } = stub([
      { id: "acc1", name: "Personal" },
      { id: "acc2", name: "Work" },
    ]);
    const res = await resolveAccount(cf);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("Personal (acc1)");
    expect(res.error).toContain("Work (acc2)");
    expect(res.error).toContain("scope it");
  });

  test("none says so rather than continuing with an empty id", async () => {
    const { cf } = stub([]);
    const res = await resolveAccount(cf);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("no accounts");
  });

  test("entries missing an id or name are not accounts", async () => {
    const { cf } = stub([{ id: "acc1" }, { name: "Nameless" }, null]);
    const res = await resolveAccount(cf);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("no accounts");
  });
});

describe("secretNames", () => {
  test("names only, from the documented list shape", async () => {
    const { cf, seen } = stub([
      { name: "CDN_PASSWORD", type: "secret_text" },
      { name: "CDN_UPLOAD_TOKEN", type: "secret_text" },
    ]);
    const res = await secretNames(cf, "acc123", "cdn-personal");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toEqual(["CDN_PASSWORD", "CDN_UPLOAD_TOKEN"]);
    expect(seen[0]).toMatchObject({
      method: "GET",
      path: "/accounts/acc123/workers/scripts/cdn-personal/secrets",
    });
  });

  test("a Worker with no secrets is an empty list, not a failure", async () => {
    const { cf } = stub([]);
    const res = await secretNames(cf, "acc123", "cdn-personal");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.result).toEqual([]);
  });

  // A 403 here is the shape of "the token has no Workers permission", which is
  // exactly the failure this whole module exists to make legible.
  test("a refusal is reported, not read as an empty list", async () => {
    const { cf } = stub(null, [], 403);
    const res = await secretNames(cf, "acc123", "cdn-personal");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("the token lacks the permission");
  });

  test("the script name is escaped into the path", async () => {
    const { cf, seen } = stub([]);
    await secretNames(cf, "acc123", "my worker");
    expect(seen[0]?.path).toBe("/accounts/acc123/workers/scripts/my%20worker/secrets");
  });
});

describe("putSecret", () => {
  test("sends the documented triple to the documented path", async () => {
    const { cf, seen } = stub({ name: "CDN_UPLOAD_TOKEN", type: "secret_text" });
    const res = await putSecret(cf, "acc123", "cdn-personal", "CDN_UPLOAD_TOKEN", "deadbeef");
    expect(res.ok).toBe(true);
    expect(seen[0]).toEqual({
      method: "PUT",
      path: "/accounts/acc123/workers/scripts/cdn-personal/secrets",
      // `{type, name, text}` — the shape the bulk endpoint documents by example
      // and the list endpoint returns. Pinned because it is the one thing here
      // the reference does not spell out on the PUT's own page.
      body: { name: "CDN_UPLOAD_TOKEN", text: "deadbeef", type: "secret_text" },
    });
  });

  test("a refusal is an error, so a caller never reports a secret it did not set", async () => {
    const { cf } = stub(null, [], 403);
    const res = await putSecret(cf, "acc123", "cdn-personal", "CDN_PURGE_TOKEN", "cfat_secret");
    expect(res.ok).toBe(false);
  });
});
