// Integration tests for the Worker's routing: public object serving (the CDN)
// and the auth gate. Runs the real Worker (SELF) against Miniflare R2 (env.BUCKET).

import { env, SELF } from "cloudflare:test";
import { describe, expect, test } from "vitest";

const BASE = "https://cdn.test";

describe("object serving (the CDN)", () => {
  test("serves an object with its stored content-type", async () => {
    await env.BUCKET.put("a1b2c3.png", new Uint8Array([1, 2, 3, 4]), {
      httpMetadata: { contentType: "image/png" },
    });
    const res = await SELF.fetch(`${BASE}/a1b2c3.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toContain("max-age");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2, 3, 4]);
  });

  test("supports range requests", async () => {
    await env.BUCKET.put("clip.bin", new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]));
    const res = await SELF.fetch(`${BASE}/clip.bin`, { headers: { Range: "bytes=2-5" } });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 2-5/10");
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([2, 3, 4, 5]);
  });

  test("HEAD returns headers, no body", async () => {
    await env.BUCKET.put("doc.txt", "hello", { httpMetadata: { contentType: "text/plain" } });
    const res = await SELF.fetch(`${BASE}/doc.txt`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("5");
    expect(await res.text()).toBe("");
  });

  test("404 for a missing key", async () => {
    expect((await SELF.fetch(`${BASE}/nope.png`)).status).toBe(404);
  });

  test("hides .keep markers and folder paths", async () => {
    await env.BUCKET.put("folder/.keep", "");
    expect((await SELF.fetch(`${BASE}/folder/.keep`)).status).toBe(404);
    expect((await SELF.fetch(`${BASE}/folder/`)).status).toBe(404);
  });
});

describe("upload (POST /api/upload)", () => {
  const BEARER = { authorization: "Bearer test-upload-token" }; // matches vitest.config.ts

  test("writes the body to R2 and returns the public url", async () => {
    const res = await SELF.fetch(`${BASE}/api/upload?key=up/hi.txt`, {
      method: "POST",
      headers: BEARER,
      body: "hello cdn",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      key: "up/hi.txt",
      url: "https://cdn.ramonfabrega.com/up/hi.txt",
    });
    const obj = await env.BUCKET.get("up/hi.txt");
    expect(await obj?.text()).toBe("hello cdn");
  });

  test("derives content-type from the key extension (not the request)", async () => {
    await SELF.fetch(`${BASE}/api/upload?key=pic.png`, {
      method: "POST",
      headers: { ...BEARER, "content-type": "text/plain" },
      body: new Uint8Array([1, 2, 3]),
    });
    const served = await SELF.fetch(`${BASE}/pic.png`);
    expect(served.headers.get("content-type")).toBe("image/png");
  });

  test("401 without a bearer, 401 with the wrong one", async () => {
    const none = await SELF.fetch(`${BASE}/api/upload?key=x.png`, { method: "POST", body: "x" });
    expect(none.status).toBe(401);
    const bad = await SELF.fetch(`${BASE}/api/upload?key=x.png`, {
      method: "POST",
      headers: { authorization: "Bearer nope" },
      body: "x",
    });
    expect(bad.status).toBe(401);
  });

  test("rejects a missing or unsafe key", async () => {
    for (const key of ["", "folder/", "../etc", ".keep"]) {
      const res = await SELF.fetch(`${BASE}/api/upload?key=${encodeURIComponent(key)}`, {
        method: "POST",
        headers: BEARER,
        body: "x",
      });
      expect(res.status).toBe(400);
    }
  });

  test("the bearer is scoped to upload — it can't reach destructive APIs", async () => {
    const res = await SELF.fetch(`${BASE}/api/delete`, {
      method: "POST",
      headers: { ...BEARER, "content-type": "application/json" },
      body: JSON.stringify({ key: "anything" }),
    });
    expect(res.status).toBe(401);
  });
});

describe("auth gate", () => {
  test("explorer root redirects to /login when unauthenticated", async () => {
    const res = await SELF.fetch(`${BASE}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
  });

  test("api is 401 when unauthenticated", async () => {
    expect((await SELF.fetch(`${BASE}/api/tree`)).status).toBe(401);
  });

  test("health + login are public", async () => {
    const health = await SELF.fetch(`${BASE}/health`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
    const login = await SELF.fetch(`${BASE}/login`);
    expect(login.status).toBe(200);
    expect(await login.text()).toContain("password");
  });
});
