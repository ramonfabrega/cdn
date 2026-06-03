// Integration tests for the Worker's routing: public object serving (the CDN)
// and the auth gate. Runs the real Worker (SELF) against Miniflare R2 (env.BUCKET).

import { SELF, env } from "cloudflare:test";
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
