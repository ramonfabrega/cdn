// The shared write path, tested through its own API rather than through one of
// its three callers. The hooks' and the CLI's suites exercise the same code from
// above; these are the cases neither of them can reach comfortably — a bad
// response shape, a 404 that isn't a Worker, the recorded-fetch seam.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { originFor, SUPPORTED_CONTRACTS, upload, verify } from "./upload.ts";

let dir = "";
let src = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdn-upload-"));
  src = join(dir, "a.txt");
  await Bun.write(src, "hello");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const target = { host: "cdn.example.com", token: "t0ken" };

/** The seam phase 5 will lean on: a fetch that answers from a script and records
    what it was asked, so a call can be tested without a server or a network. */
const recorder = (reply: (req: Request) => Response) => {
  const seen: Request[] = [];
  const fetch = (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input instanceof Request ? input : String(input), init);
    seen.push(req.clone());
    return Promise.resolve(reply(req));
  };
  return { fetch: fetch as typeof globalThis.fetch, seen };
};

describe("originFor", () => {
  test("https everywhere except loopback, which is wrangler dev", () => {
    expect(originFor("cdn.example.com")).toBe("https://cdn.example.com");
    expect(originFor("localhost:8787")).toBe("http://localhost:8787");
    expect(originFor("127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    // Only the exact loopback names — a domain that merely starts with one is a
    // real host with a real certificate.
    expect(originFor("localhost.example.com")).toBe("https://localhost.example.com");
    expect(originFor("127.0.0.1.example.com")).toBe("https://127.0.0.1.example.com");
  });
});

describe("upload", () => {
  test("sends the bearer and the key, and returns what the Worker minted", async () => {
    const rec = recorder(() =>
      Response.json({ ok: true, key: "a/b.txt", url: "https://x/a/b.txt", permanent: false })
    );
    const res = await upload(target, src, "a/b.txt", { fetch: rec.fetch });

    expect(res).toEqual({
      ok: true,
      uploaded: { url: "https://x/a/b.txt", key: "a/b.txt", permanent: false },
    });
    const req = rec.seen[0];
    expect(req?.method).toBe("POST");
    expect(req?.headers.get("authorization")).toBe("Bearer t0ken");
    expect(new URL(req?.url ?? "").searchParams.get("key")).toBe("a/b.txt");
    expect(await req?.text()).toBe("hello");
  });

  // Absent means "keep whatever the key already had". A release script that
  // forgets --permanent must not silently re-arm the sweep on a key someone
  // deliberately marked, so `false` sends nothing rather than `permanent=0`.
  test("permanent is sent only when asked for", async () => {
    const reply = () => Response.json({ ok: true, key: "k", url: "https://x/k", permanent: true });

    const on = recorder(reply);
    await upload(target, src, "k", { permanent: true, fetch: on.fetch });
    expect(new URL(on.seen[0]?.url ?? "").searchParams.get("permanent")).toBe("1");

    const off = recorder(reply);
    await upload(target, src, "k", { permanent: false, fetch: off.fetch });
    expect(new URL(off.seen[0]?.url ?? "").searchParams.has("permanent")).toBe(false);
  });

  test("a 401 names the command that fixes it", async () => {
    const rec = recorder(() => new Response("unauthorized", { status: 401 }));
    const res = await upload(target, src, "k", { fetch: rec.fetch });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("401");
    expect(res.error).toContain("cdn auth login --host cdn.example.com");
  });

  // A 404 from a host that answers is a different problem from a rejected token,
  // and reads identically if all you see is a number.
  test("a 404 says the host answered but isn't a cdn Worker", async () => {
    const rec = recorder(() => new Response("nope", { status: 404 }));
    const res = await upload(target, src, "k", { fetch: rec.fetch });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("not a cdn Worker");
  });

  test("a 200 with the wrong shape is a failure, not a silent undefined url", async () => {
    const rec = recorder(() => Response.json({ ok: true, surprise: 1 }));
    const res = await upload(target, src, "k", { fetch: rec.fetch });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("no url");
  });

  test("a thrown fetch becomes an error value", async () => {
    const boom: typeof globalThis.fetch = () => Promise.reject(new Error("ECONNREFUSED"));
    const res = await upload(target, src, "k", { fetch: boom });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("unreachable");
    expect(res.error).toContain("ECONNREFUSED");
  });
});

describe("verify", () => {
  // Logging in should not have to upload a file to find out whether the token
  // works, so the Worker grew a cheap authenticated no-op for exactly this.
  test("GETs /api/auth with the bearer and reports the contract", async () => {
    const rec = recorder(() => Response.json({ contract: 1 }));
    const res = await verify(target, { fetch: rec.fetch });
    expect(res).toEqual({ ok: true, contract: 1 });
    expect(rec.seen[0]?.url).toBe("https://cdn.example.com/api/auth");
    expect(rec.seen[0]?.method).toBe("GET");
    expect(rec.seen[0]?.headers.get("authorization")).toBe("Bearer t0ken");
  });

  test("a rejected token is a value with the login command in it", async () => {
    const rec = recorder(() => new Response("unauthorized", { status: 401 }));
    const res = await verify(target, { fetch: rec.fetch });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("cdn auth login --host cdn.example.com");
  });

  // The two sides are allowed to be different ages — that is the point of the
  // number. What must not happen is a client discovering the mismatch three calls
  // later, as a field that isn't there.
  test("a contract this client does not speak fails at the handshake, naming both", async () => {
    const rec = recorder(() => Response.json({ contract: 7 }));
    const res = await verify(target, { fetch: rec.fetch });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("contract 7");
    expect(res.error).toContain(SUPPORTED_CONTRACTS.join(", "));
    expect(res.error).toContain("upgrade whichever is older");
  });

  test("an answer with no contract at all is treated as unknown", async () => {
    const rec = recorder(() => Response.json({ ok: true }));
    const res = await verify(target, { fetch: rec.fetch });
    expect(res.ok).toBe(false);
  });
});
