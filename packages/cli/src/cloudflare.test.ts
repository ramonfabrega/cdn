// The Cloudflare client has no production caller yet — phase 5 (`cdn setup`) is
// what it exists for. These tests ARE its caller for now, and they pin the three
// behaviours that would otherwise be discovered the hard way, against a live
// account, while trying to write something else.

import { describe, expect, test } from "bun:test";

import { call } from "./cloudflare.ts";

const recorder = (reply: (req: Request) => Response) => {
  const seen: Request[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input instanceof Request ? input : String(input), init);
    seen.push(req.clone());
    return Promise.resolve(reply(req));
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
};

const opts = (fetch: typeof globalThis.fetch) => ({ token: "cfat_x", fetch });

describe("call", () => {
  test("sends the bearer and unwraps result on success", async () => {
    const rec = recorder(() => Response.json({ success: true, errors: [], result: { id: "z1" } }));
    const res = await call<{ id: string }>(opts(rec.fetch), "GET", "/zones/z1");

    expect(res).toEqual({ ok: true, result: { id: "z1" } });
    expect(rec.seen[0]?.url).toBe("https://api.cloudflare.com/client/v4/zones/z1");
    expect(rec.seen[0]?.headers.get("authorization")).toBe("Bearer cfat_x");
    // No body, no content-type: a GET that declares JSON it isn't sending is the
    // kind of thing some proxies reject.
    expect(rec.seen[0]?.headers.get("content-type")).toBeNull();
  });

  test("a body is JSON, with the header to match", async () => {
    const rec = recorder(() => Response.json({ success: true, errors: [], result: null }));
    await call(opts(rec.fetch), "POST", "/zones/z1/purge_cache", { files: ["https://x/a"] });

    const req = rec.seen[0];
    expect(req?.method).toBe("POST");
    expect(req?.headers.get("content-type")).toBe("application/json");
    expect(await req?.json()).toEqual({ files: ["https://x/a"] });
  });

  // The whole reason this module exists rather than three inline lines: a 200
  // whose body says `success: false` is a real Cloudflare answer, and trusting
  // the status code accepts it as a win.
  test("a 200 with success:false is a failure, and says why", async () => {
    const rec = recorder(() =>
      Response.json({
        success: false,
        errors: [{ code: 1004, message: "DNS Validation Error" }],
        result: null,
      })
    );
    const res = await call(opts(rec.fetch), "POST", "/zones/z1/dns_records", {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("DNS Validation Error");
    expect(res.error).toContain("1004");
  });

  test("a 403 says the token lacks the permission, not just the number", async () => {
    const rec = recorder(
      () =>
        new Response(
          JSON.stringify({ success: false, errors: [{ code: 10000, message: "Auth" }] }),
          {
            status: 403,
          }
        )
    );
    const res = await call(opts(rec.fetch), "PATCH", "/zones/z1/settings/browser_cache_ttl", {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(403);
    expect(res.error).toContain("lacks the permission");
  });

  test("a non-JSON answer is a failure, not a crash", async () => {
    const rec = recorder(() => new Response("<html>gateway timeout</html>", { status: 504 }));
    const res = await call(opts(rec.fetch), "GET", "/zones");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("504");
  });

  test("an unreachable API is an error value", async () => {
    const boom: typeof globalThis.fetch = () => Promise.reject(new Error("ENOTFOUND"));
    const res = await call(opts(boom), "GET", "/zones");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("unreachable");
    expect(res.error).toContain("ENOTFOUND");
  });
});
