// cdn explorer — a thin Hono app that lists the R2 bucket behind a password.
//
// Runs on Bun locally (this file) and is designed to lift to a Worker later:
// only `storage.ts` and the secret-loading below are runtime-specific; the
// routes and UI are portable.
//
//   CDN_PASSWORD=hunter2 bun run --hot server.ts   # -> http://localhost:3000
//
// If CDN_PASSWORD is unset, a loud dev default is used (fine for localhost only).

import { Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";

import { DOMAIN } from "./lib/cdn.ts";
import { createFolder, move, remove, rename, tree } from "./storage.ts";

const PASSWORD = process.env.CDN_PASSWORD ?? "letmein";
if (!process.env.CDN_PASSWORD) {
  console.warn(
    "⚠  CDN_PASSWORD not set — using dev default 'letmein'. Set it for anything non-local."
  );
}
// Deterministic session secret so cookies survive restarts during dev.
const SECRET = process.env.CDN_SESSION_SECRET ?? `${PASSWORD}::cdn-explorer-session`;
const COOKIE = "cdn_session";
const PUBLIC_PATHS = new Set(["/login", "/health"]);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

const app = new Hono();

// never let the browser cache the explorer/assets/API — fixes "reload shows stale UI"
app.use("*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
});

// ── auth gate (registered first → wraps every route) ────────────────────────
app.use("*", async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_PATHS.has(path)) return next();
  const ok = await getSignedCookie(c, SECRET, COOKIE);
  if (ok !== "ok") {
    if (path.startsWith("/api/")) return c.json({ error: "unauthorized" }, 401);
    return c.redirect("/login");
  }
  return next();
});

app.get("/health", (c) => c.text("ok"));

// ── login / logout ──────────────────────────────────────────────────────────
app.get("/login", (c) => c.html(loginPage()));

app.post("/login", async (c) => {
  const body = await c.req.parseBody();
  if (body.password === PASSWORD) {
    await setSignedCookie(c, COOKIE, "ok", SECRET, {
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 60 * 60 * 24 * 30, // 30 days
    });
    return c.redirect("/");
  }
  return c.html(loginPage("Wrong password."), 401);
});

app.get("/logout", (c) => {
  deleteCookie(c, COOKIE, { path: "/" });
  return c.redirect("/login");
});

// ── listing API ───────────────────────────────────────────────────────────
// Full enriched object list; the client builds the folder tree from the keys.
app.get("/api/tree", async (c) => {
  try {
    return c.json({ domain: DOMAIN, objects: await tree() });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 500);
  }
});

// ── mutations (all destructive to public URLs — client confirms first) ──────
app.post("/api/folder", async (c) => {
  try {
    const { prefix = "", name } = await c.req.json();
    const key = await createFolder(prefix, name);
    return c.json({ ok: true, key });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 400);
  }
});

// move accepts a single `from` or a batch `keys: string[]`, all into folder `to`.
app.post("/api/move", async (c) => {
  try {
    const { from, keys, to = "" } = await c.req.json();
    const list: string[] = Array.isArray(keys) ? keys : from ? [from] : [];
    if (!list.length) throw new Error("missing 'from' or 'keys'");
    const results: { key: string; ok: boolean; error?: string }[] = [];
    let moved = 0;
    for (const k of list) {
      try {
        moved += await move(k, to);
        results.push({ key: k, ok: true });
      } catch (e) {
        results.push({ key: k, ok: false, error: errMsg(e) });
      }
    }
    return c.json({ ok: results.every((r) => r.ok), moved, results });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 400);
  }
});

app.post("/api/rename", async (c) => {
  try {
    const { key, name } = await c.req.json();
    if (!key) throw new Error("missing 'key'");
    const renamed = await rename(key, name);
    return c.json({ ok: true, renamed });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 400);
  }
});

// delete accepts a single `key` or a batch `keys: string[]`.
app.post("/api/delete", async (c) => {
  try {
    const { key, keys } = await c.req.json();
    const list: string[] = Array.isArray(keys) ? keys : key ? [key] : [];
    if (!list.length) throw new Error("missing 'key' or 'keys'");
    const results: { key: string; ok: boolean; error?: string }[] = [];
    let deleted = 0;
    for (const k of list) {
      try {
        deleted += await remove(k);
        results.push({ key: k, ok: true });
      } catch (e) {
        results.push({ key: k, ok: false, error: errMsg(e) });
      }
    }
    return c.json({ ok: results.every((r) => r.ok), deleted, results });
  } catch (e) {
    return c.json({ error: errMsg(e) }, 400);
  }
});

// ── explorer UI ─────────────────────────────────────────────────────────────
// Serve the whole explorer as ONE self-contained document: css + js are inlined
// into index.html so the first (and only) paint is fully styled and interactive.
// No render-blocking subrequest ⇒ no flash of unstyled content, even on GPRS.
// Source files stay separate on disk; we just compose them at serve time.
// (Lifting to a Worker: read these three via text-imports instead of Bun.file.)
const PUBLIC_DIR = `${import.meta.dir}/public`;
function inlineOnce(html: string, marker: string, replacement: string): string {
  if (!html.includes(marker)) throw new Error(`inline marker missing: ${marker}`);
  return html.replace(marker, () => replacement); // fn replacer: css/js contain `$`
}
app.get("/", async (c) => {
  const [html, css, js] = await Promise.all([
    Bun.file(`${PUBLIC_DIR}/index.html`).text(),
    Bun.file(`${PUBLIC_DIR}/styles.css`).text(),
    Bun.file(`${PUBLIC_DIR}/app.js`).text(),
  ]);
  const page = inlineOnce(
    inlineOnce(html, '<link rel="stylesheet" href="/styles.css">', `<style>${css}</style>`),
    '<script type="module" src="/app.js"></script>',
    `<script type="module">${js}</script>`
  );
  return c.html(page);
});

function loginPage(error?: string): string {
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>cdn · sign in</title>
<style>
  :root{color-scheme:light dark}
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
    background:#0b0c0e;color:#e7e9ee}
  form{width:min(92vw,320px);display:flex;flex-direction:column;gap:14px;
    padding:28px;border:1px solid #23262d;border-radius:16px;background:#121419}
  h1{margin:0;font-size:15px;letter-spacing:.04em;color:#9aa3b2;font-weight:600}
  h1 b{color:#e7e9ee;font-weight:600}
  input{padding:11px 13px;border:1px solid #2b2f38;border-radius:10px;
    background:#0b0c0e;color:#e7e9ee;font-size:15px;outline:none}
  input:focus{border-color:#4c7dff}
  button{padding:11px;border:0;border-radius:10px;background:#4c7dff;color:#fff;
    font-size:15px;font-weight:600;cursor:pointer}
  button:hover{background:#3d6cf0}
  .err{color:#ff7a7a;font-size:13px;margin:0}
</style></head><body>
<form method="post" action="/login">
  <h1>🔒 <b>cdn</b>.ramonfabrega.com</h1>
  ${error ? `<p class="err">${error}</p>` : ""}
  <input type="password" name="password" placeholder="password" autofocus required>
  <button type="submit">Enter</button>
</form></body></html>`;
}

export default {
  port: Number(process.env.PORT ?? 3000),
  fetch: app.fetch,
};
