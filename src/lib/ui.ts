// Shared design tokens + formatters for the server-rendered pages (folder
// listing, login — and future og:image cards). Mirror of public/styles.css;
// pure and dep-free like the rest of lib/. Each page inlines BASE_TOKENS into
// its own `:root{…}` and appends page-specific extras.

export const BASE_TOKENS = `color-scheme:light dark;
    --bg:light-dark(oklch(97.5% .004 265),oklch(15% .008 265));
    --card:light-dark(oklch(99.5% .002 265),oklch(19% .009 265));
    --line:light-dark(oklch(91% .01 265),oklch(26% .013 265));
    --line2:light-dark(oklch(86% .013 265),oklch(31% .016 265));
    --ink:light-dark(oklch(25% .02 265),oklch(94% .008 265));
    --dim:light-dark(oklch(45% .022 265),oklch(71% .023 265));
    --faint:light-dark(oklch(60% .018 265),oklch(52% .022 265));
    --shadow:light-dark(oklch(50% .03 265/.15),oklch(0% 0 0/.5));`;

// type-badge hues — mirror of styles.css --t-* (server pages inline their own CSS)
export const BADGE: Record<string, string> = {
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

/** Root-absolute, percent-encoded href for a key/prefix — works on any host (dev + prod). */
export const href = (key: string) => `/${key.split("/").map(encodeURIComponent).join("/")}`;

export const fmtSize = (b: number) => {
  const u = ["B", "KB", "MB", "GB", "TB"];
  let n = b;
  let i = 0;
  while (n >= 1024 && i < u.length - 1) {
    n /= 1024;
    i++;
  }
  return `${i ? n.toFixed(1) : n} ${u[i]}`;
};

export const fmtDate = (s: string) =>
  new Date(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

/** Split a request host into the brand lockup every page wears: first label is
    the name (bold), the rest is the zone (dimmed) — `cdn` + `.example.com`. A
    single-label host (`localhost:8787`) is all name. Nothing here is configured:
    the Worker brands itself with whatever host you reached it on, so a fork, a
    preview build and `wrangler dev` are each labelled correctly with no var to
    set — and a template ships with no domain of its author's baked in. */
export const brand = (host: string): { name: string; rest: string } => {
  const dot = host.indexOf(".");
  return dot === -1
    ? { name: host, rest: "" }
    : { name: host.slice(0, dot), rest: host.slice(dot) };
};

const ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** Escape for interpolation into raw HTML. The .tsx pages get this free from
    hono/jsx; the explorer shell is a string-substituted asset, so it escapes by
    hand — the host is a request header, i.e. attacker-controlled input. */
export const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ENTITIES[c] ?? c);
