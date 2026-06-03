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
  /* same OKLCH palette as the explorer (styles.css), light + dark via light-dark() */
  :root{
    color-scheme:light dark;
    --bg:light-dark(oklch(97.5% .004 265),oklch(15% .008 265));
    --card:light-dark(oklch(99.5% .002 265),oklch(19% .009 265));
    --line:light-dark(oklch(91% .01 265),oklch(26% .013 265));
    --line2:light-dark(oklch(86% .013 265),oklch(31% .016 265));
    --ink:light-dark(oklch(25% .02 265),oklch(94% .008 265));
    --dim:light-dark(oklch(45% .022 265),oklch(71% .023 265));
    --faint:light-dark(oklch(60% .018 265),oklch(52% .022 265));
    --accent:oklch(58% .19 265);
    --on-accent:oklch(100% 0 0);
    --red:oklch(62% .2 20);
    --shadow:light-dark(oklch(50% .03 265/.15),oklch(0% 0 0/.5));
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
    background:var(--bg);color:var(--ink)}
  form{width:min(92vw,320px);display:flex;flex-direction:column;gap:14px;
    padding:28px;border:1px solid var(--line2);border-radius:16px;
    background:var(--card);box-shadow:0 16px 48px var(--shadow)}
  h1{margin:0;font-size:15px;letter-spacing:.04em;color:var(--dim);font-weight:600}
  h1 b{color:var(--ink);font-weight:600}
  input{padding:11px 13px;border:1px solid var(--line);border-radius:10px;
    background:var(--bg);color:var(--ink);font-size:15px;outline:none}
  input::placeholder{color:var(--faint)}
  input:focus{border-color:var(--accent)}
  button{padding:11px;border:0;border-radius:10px;background:var(--accent);
    color:var(--on-accent);font-size:15px;font-weight:600;cursor:pointer;
    transition:filter .15s}
  button:hover{filter:brightness(1.08)}
  .err{color:var(--red);font-size:13px;margin:0}
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
