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

  test("hides .keep markers", async () => {
    await env.BUCKET.put("folder/.keep", "");
    expect((await SELF.fetch(`${BASE}/folder/.keep`)).status).toBe(404);
  });

  test("objects revalidate client-side, cache an hour per edge POP", async () => {
    // One policy for every key: keys are overwritable in place, so browsers must
    // revalidate each view (max-age=0 → cheap 304s) while the edge holds the bytes.
    await env.BUCKET.put("mux/appcast.xml", "<rss/>");
    await env.BUCKET.put("mux/App.zip", "zipbytes");
    for (const key of ["mux/appcast.xml", "mux/App.zip"]) {
      const res = await SELF.fetch(`${BASE}/${key}`);
      expect(res.headers.get("cache-control")).toBe("public, max-age=0, s-maxage=3600");
    }
  });
});

describe("folder share pages", () => {
  test("a folder URL lists its files and subfolders (public, no auth)", async () => {
    await env.BUCKET.put("golf-sim/sfx-family/1.wav", "a");
    await env.BUCKET.put("golf-sim/sfx-family/2.wav", "bb");
    await env.BUCKET.put("golf-sim/sfx-family/alt/3.wav", "ccc");
    const res = await SELF.fetch(`${BASE}/golf-sim/sfx-family/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const html = await res.text();
    expect(html).toContain("1.wav");
    expect(html).toContain("2.wav");
    // Contents (files + child folders) link to their ABSOLUTE public url, so an
    // HTML→markdown fetch keeps a usable URL — read the page once, fetch each file.
    expect(html).toContain('href="https://cdn.test/golf-sim/sfx-family/1.wav"');
    expect(html).toContain('href="https://cdn.test/golf-sim/sfx-family/alt/"'); // subfolder → its own page
    // Upward nav (the `..` parent) stays RELATIVE — we publish absolute urls for a
    // folder's own contents, not a frictionless machine path up toward the roots.
    expect(html).toContain('href="/golf-sim/"');
    expect(html).not.toContain('href="https://cdn.test/golf-sim/"');
    expect(html).not.toContain("3.wav"); // one level only — nested files stay behind their folder
  });

  test("percent-encodes hrefs for keys with spaces/unicode", async () => {
    await env.BUCKET.put("shots/Screen Shot é.png", "x");
    const html = await (await SELF.fetch(`${BASE}/shots/`)).text();
    expect(html).toContain('href="https://cdn.test/shots/Screen%20Shot%20%C3%A9.png"');
  });

  test("urls carry the REQUEST host — a preview build links to itself, not prod", async () => {
    await env.BUCKET.put("multi/pic.png", "x");
    const html = await (await SELF.fetch("https://preview.cdn.test/multi/")).text();
    expect(html).toContain('href="https://preview.cdn.test/multi/pic.png"');
    expect(html).toContain('property="og:url" content="https://preview.cdn.test/multi/"');
    expect(html).not.toContain("https://cdn.test/"); // no host but the one that asked
  });

  test("hides .keep and renders an empty page for a marker-only folder", async () => {
    await env.BUCKET.put("empty-folder/.keep", "");
    const res = await SELF.fetch(`${BASE}/empty-folder/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).not.toContain(".keep");
    expect(html).toContain("Empty folder");
  });

  test("404 for a prefix with no objects at all", async () => {
    expect((await SELF.fetch(`${BASE}/no-such-folder/`)).status).toBe(404);
  });

  test("missing trailing slash redirects to the folder URL", async () => {
    await env.BUCKET.put("golf-sim/sfx-family/1.wav", "a");
    const res = await SELF.fetch(`${BASE}/golf-sim/sfx-family`, { redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/golf-sim/sfx-family/");
  });

  test("a plain missing object is still a 404 (no folder probe hit)", async () => {
    expect((await SELF.fetch(`${BASE}/nope.png`)).status).toBe(404);
  });

  test("HEAD on a folder URL returns headers, no body", async () => {
    await env.BUCKET.put("h/x.txt", "x");
    const res = await SELF.fetch(`${BASE}/h/`, { method: "HEAD" });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  test("carries og/twitter unfurl meta pointing at the request host's card URL", async () => {
    await env.BUCKET.put("golf-sim/sfx family/1.wav", "aaa");
    const html = await (await SELF.fetch(`${BASE}/golf-sim/sfx%20family/`)).text();
    expect(html).toContain('property="og:title" content="sfx family/"');
    expect(html).toContain('property="og:description" content="1 item · 3 B"');
    expect(html).toContain('property="og:url" content="https://cdn.test/golf-sim/sfx%20family/"');
    expect(html).toContain(
      'property="og:image" content="https://cdn.test/.og/golf-sim/sfx%20family.png"'
    );
    expect(html).toContain('name="twitter:card" content="summary_large_image"');
  });
});

describe("og:image cards (GET /.og/<prefix>.png)", () => {
  test("renders a PNG for a folder prefix (public, short max-age)", async () => {
    await env.BUCKET.put("golf-sim/sfx-family/1.wav", "aaa");
    const res = await SELF.fetch(`${BASE}/.og/golf-sim/sfx-family.png`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG magic
  });

  test("404 for a prefix with no objects, and for a card URL without .png", async () => {
    expect((await SELF.fetch(`${BASE}/.og/no-such-folder.png`)).status).toBe(404);
    await env.BUCKET.put("real/x.txt", "x");
    expect((await SELF.fetch(`${BASE}/.og/real`)).status).toBe(404);
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
      url: "https://cdn.test/up/hi.txt",
      permanent: false,
    });
    const obj = await env.BUCKET.get("up/hi.txt");
    expect(await obj?.text()).toBe("hello cdn");
  });

  test("an overwrite serves the new bytes immediately (edge cache purged)", async () => {
    const upload = (body: string) =>
      SELF.fetch(`${BASE}/api/upload?key=twice.txt`, { method: "POST", headers: BEARER, body });
    await upload("v1");
    expect(await (await SELF.fetch(`${BASE}/twice.txt`)).text()).toBe("v1"); // primes the cache
    await upload("v2");
    expect(await (await SELF.fetch(`${BASE}/twice.txt`)).text()).toBe("v2");
  });

  test("?permanent=1 flags the object; later overwrites keep the flag", async () => {
    const up = (query: string) =>
      SELF.fetch(`${BASE}/api/upload?key=mux/x.zip${query}`, {
        method: "POST",
        headers: BEARER,
        body: "z",
      });
    expect(await (await up("&permanent=1")).json()).toMatchObject({ permanent: true });
    expect((await env.BUCKET.head("mux/x.zip"))?.customMetadata?.permanent).toBe("1");
    // overwrite WITHOUT the param — the flag must survive (release scripts may forget it)
    expect(await (await up("")).json()).toMatchObject({ permanent: true });
    expect((await env.BUCKET.head("mux/x.zip"))?.customMetadata?.permanent).toBe("1");
    // explicit permanent=0 clears it
    expect(await (await up("&permanent=0")).json()).toMatchObject({ permanent: false });
    expect((await env.BUCKET.head("mux/x.zip"))?.customMetadata?.permanent).toBeUndefined();
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
    for (const api of ["/api/delete", "/api/permanent"]) {
      const res = await SELF.fetch(`${BASE}${api}`, {
        method: "POST",
        headers: { ...BEARER, "content-type": "application/json" },
        body: JSON.stringify({ key: "anything" }),
      });
      expect(res.status).toBe(401);
    }
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

describe("explorer root (streamed shell + embedded tree)", () => {
  const PW = "test-password"; // matches vitest.config.ts
  // Sign in the same way the login form does, and hand back the session cookie
  // for a follow-up authenticated GET.
  async function sessionCookie() {
    const res = await SELF.fetch(`${BASE}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: `password=${encodeURIComponent(PW)}`,
    });
    expect(res.status).toBe(302);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("cdn_session=");
    return setCookie.split(";")[0]; // "cdn_session=<signed>"
  }

  test("GET / streams the inlined shell with the file list embedded as window.__tree", async () => {
    await env.BUCKET.put("root-doc.txt", "hi", { httpMetadata: { contentType: "text/plain" } });
    const res = await SELF.fetch(`${BASE}/`, { headers: { cookie: await sessionCookie() } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");

    const html = await res.text();
    // The data rides along on the same response — no /api/tree round-trip on boot.
    expect(html).toContain("window.__tree=");
    expect(html).toContain("root-doc.txt");
    // css + js are inlined (one self-contained document), not left as subrequests.
    expect(html).toContain("<style>");
    expect(html).not.toContain('href="/styles.css"');
    expect(html).toContain('<script type="module">');
    expect(html).not.toContain('src="/app.js"');
  });

  test("embedded tree is XSS-safe: a '<' in a key can't break out of the <script>", async () => {
    await env.BUCKET.put("x/</script><b>.txt", "x");
    const res = await SELF.fetch(`${BASE}/`, { headers: { cookie: await sessionCookie() } });
    const html = await res.text();
    // The raw closing tag must not appear inside the embedded blob — `<` is escaped.
    expect(html).toContain("window.__tree=");
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("\\u003c/script>");
  });
});
