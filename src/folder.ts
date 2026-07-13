// Public folder share page — what a folder URL (…/golf-sim/sfx-family/) renders.
// Read-only and unauthenticated by design: the objects under a prefix are already
// public, this just makes the "natural" folder link resolve to a listing of them
// instead of a 404. Same OKLCH palette as the explorer; zero JS.

import type { Entry } from "./storage.ts";

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/** Root-absolute, percent-encoded href for a key/prefix — works on any host (dev + prod). */
const href = (key: string) => `/${key.split("/").map(encodeURIComponent).join("/")}`;

const fmtSize = (b: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let n = b;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
};
const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// type-badge hues — mirror of styles.css --t-* (this page inlines its own CSS)
const BADGE: Record<string, string> = {
  image: "oklch(71% .16 294)",
  video: "oklch(72% .17 350)",
  audio: "oklch(80% .13 212)",
  pdf: "oklch(72% .17 13)",
  html: "oklch(76% .16 56)",
  code: "oklch(77% .15 163)",
  text: "oklch(71% .14 255)",
  archive: "oklch(84% .16 84)",
  file: "oklch(62% .03 265)",
};

/** Breadcrumb: each ancestor segment links to its own folder page; the root
    crumb is plain text (/" is the gated explorer — don't send guests to a login). */
function crumbs(prefix: string): string {
  const parts = prefix.replace(/\/$/, "").split("/");
  let acc = "";
  const out = parts.map((p, i) => {
    acc += `${p}/`;
    return i === parts.length - 1 ? `<b>${esc(p)}</b>` : `<a href="${href(acc)}">${esc(p)}</a>`;
  });
  return out.join('<span class="sep">/</span>');
}

export function folderPage(prefix: string, files: Entry[], folders: string[]): string {
  const name = prefix.replace(/\/$/, "").split("/").pop() ?? prefix;
  const total = files.reduce((n, f) => n + f.size, 0);
  const sorted = [...files].sort((a, b) =>
    a.key.localeCompare(b.key, undefined, { numeric: true })
  );
  const parent = prefix.replace(/[^/]+\/$/, "");

  const folderRows = folders
    .map((f) => {
      const label = f.slice(prefix.length).replace(/\/$/, "");
      return `<a class="row" href="${href(f)}"><span class="nm">${FOLDER_ICO}${esc(label)}/</span><span class="badge dirb">dir</span><span class="sz"></span><span class="dt"></span></a>`;
    })
    .join("");
  const fileRows = sorted
    .map((f) => {
      const base = f.key.slice(prefix.length);
      const hue = BADGE[f.category] ?? BADGE.file;
      return `<a class="row" href="${href(f.key)}"><span class="nm">${esc(base)}</span><span class="badge" style="background:${hue}">${esc(f.ext || "file")}</span><span class="sz">${fmtSize(f.size)}</span><span class="dt">${fmtDate(f.lastModified)}</span></a>`;
    })
    .join("");
  const upRow = parent
    ? `<a class="row up" href="${href(parent)}"><span class="nm">..</span><span class="badge dirb">dir</span><span class="sz"></span><span class="dt"></span></a>`
    : "";
  const items = folders.length + sorted.length;
  const meta = `${items} item${items === 1 ? "" : "s"}${total ? ` · ${fmtSize(total)}` : ""}`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(name)} · cdn</title>
<style>
  :root{
    color-scheme:light dark;
    --bg:light-dark(oklch(97.5% .004 265),oklch(15% .008 265));
    --well:light-dark(oklch(96% .006 265),oklch(17.5% .009 265));
    --card:light-dark(oklch(99.5% .002 265),oklch(19% .009 265));
    --hover:light-dark(oklch(94% .009 265),oklch(22% .012 265));
    --line:light-dark(oklch(91% .01 265),oklch(26% .013 265));
    --line2:light-dark(oklch(86% .013 265),oklch(31% .016 265));
    --ink:light-dark(oklch(25% .02 265),oklch(94% .008 265));
    --dim:light-dark(oklch(45% .022 265),oklch(71% .023 265));
    --faint:light-dark(oklch(60% .018 265),oklch(52% .022 265));
    --on-bright:oklch(20% .01 265);
    --shadow:light-dark(oklch(50% .03 265/.15),oklch(0% 0 0/.5));
    --mono:ui-monospace,"SF Mono",Menlo,monospace;
    --sans:system-ui,-apple-system,sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);
    -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;
    min-height:100dvh;display:flex;flex-direction:column;align-items:center;
    padding:clamp(16px,4vw,44px) clamp(10px,3vw,24px)}
  .wrap{width:min(860px,100%)}
  .top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:0 4px 12px}
  .crumbs{font:15px var(--mono);color:var(--dim);word-break:break-all}
  .crumbs a{color:var(--dim);text-decoration:none}
  .crumbs a:hover{color:var(--ink);text-decoration:underline}
  .crumbs b{color:var(--ink);font-weight:600}
  .crumbs .sep{color:var(--faint);padding:0 5px}
  .meta{margin-left:auto;font:12px var(--mono);color:var(--faint);white-space:nowrap}
  .card{background:var(--card);border:1px solid var(--line2);border-radius:12px;
    box-shadow:0 10px 32px var(--shadow);overflow:hidden}
  .row{display:grid;grid-template-columns:1fr 58px 78px 96px;align-items:center;gap:12px;
    padding:0 16px;height:44px;border-top:1px solid var(--line);
    color:inherit;text-decoration:none;font:13px var(--mono)}
  .row:first-child{border-top:0}
  .row:hover{background:var(--hover)}
  .nm{display:flex;align-items:center;gap:9px;min-width:0;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  .nm svg{flex:none;color:var(--dim)}
  .up .nm{color:var(--faint)}
  .badge{font:600 10px/1 var(--sans);letter-spacing:.04em;text-transform:uppercase;
    text-align:center;padding:4px 6px;border-radius:5px;color:var(--on-bright)}
  .dirb{background:none;border:1px solid var(--line2);color:var(--faint)}
  .sz{font-size:12px;color:var(--dim);text-align:right}
  .dt{font-size:12px;color:var(--dim);text-align:right}
  .empty{padding:44px 16px;text-align:center;color:var(--faint);font-size:13px}
  footer{padding:16px 4px;font:11px var(--mono);color:var(--faint)}
  footer b{color:var(--dim);font-weight:600}
  @media (max-width:560px){
    .row{grid-template-columns:1fr 52px 70px;gap:8px}
    .dt{display:none}
  }
</style></head><body>
<div class="wrap">
  <div class="top"><span class="crumbs">${crumbs(prefix)}<span class="sep">/</span></span><span class="meta">${meta}</span></div>
  <div class="card">${upRow + folderRows + fileRows || '<div class="empty">Empty folder.</div>'}</div>
  <footer><b>cdn</b>.ramonfabrega.com</footer>
</div>
</body></html>`;
}

const FOLDER_ICO =
  '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/></svg>';
