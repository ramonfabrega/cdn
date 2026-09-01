// Pure, dependency-free helpers for the cdn Worker: key → MIME content-typing and
// key → { ext, category } classification (the explorer's badges + the content-type
// stored on upload). No external deps, no runtime-specific APIs — just string ops —
// so it's trivially testable and keeps the Worker bundle lean. The `share` CLI used
// to import from here; it now owns its own tiny helpers, so this module is
// Worker-internal.

/** Lowercased extension of a path incl. the dot (".png"), or "" — matches node's
    extname (leading-dot files like ".keep" have no extension). Inlined to keep
    this module dependency-free. */
function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/** A text-ish type with its charset spelled out. Every type whose bytes are
    characters gets this: with no charset parameter the browser falls back to a
    latin-1-ish default, and UTF-8 punctuation (em-dashes, arrows, ×, ≤,
    box-drawing) renders as mojibake. `text/plain` has no in-band way to declare
    an encoding — no <meta>, no XML prolog — so the header is the ONLY place it
    can be said, which is why the fix lives here and not in the file. HTML/SVG
    could declare it themselves; they shouldn't have to, and the files we upload
    are just as often someone else's. */
const utf8 = (type: string) => `${type}; charset=utf-8`;

/** Extension -> MIME type. Anything not here falls back to octet-stream. */
export const MIME_TYPES: Record<string, string> = {
  ".html": utf8("text/html"),
  ".htm": utf8("text/html"),
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": utf8("image/svg+xml"),
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".json": utf8("application/json"),
  ".css": utf8("text/css"),
  ".js": utf8("text/javascript"),
  ".mjs": utf8("text/javascript"),
  ".txt": utf8("text/plain"),
  ".md": utf8("text/plain"),
};

/** Pick a content-type from a path/key extension. */
export function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Public URL for an object key on `origin` (a URL.origin, e.g. "https://cdn.test"
    — no trailing slash). The origin comes from the REQUEST, never a hardcoded
    canonical domain: the Worker answers on several hosts (the custom domain,
    preview builds, wrangler dev), and links must stay on the host that served
    them — a preview page pointing at prod would sabotage exactly what a preview
    is for. Each path segment is percent-encoded (spaces, unicode, etc.) so the
    URL is paste-safe; the Worker decodes on serve. */
export function publicUrl(origin: string, key: string): string {
  const segments = key.replace(/^\//, "").split("/");
  return `${origin}/${segments.map(encodeURIComponent).join("/")}`;
}

// ── type classification (drives the explorer's badges) ──────────────────────

/** ext -> visual category (drives badge color in the UI). */
const CATEGORY_EXTS: Record<string, string[]> = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"],
  video: ["mp4", "mov", "webm", "m4v", "mkv", "avi"],
  audio: ["mp3", "wav", "m4a", "ogg", "flac"],
  pdf: ["pdf"],
  html: ["html", "htm"],
  code: ["js", "mjs", "ts", "tsx", "jsx", "json", "css", "yml", "yaml", "toml", "xml", "csv", "sh"],
  text: ["txt", "md", "log"],
  archive: ["zip", "tar", "gz", "tgz", "rar", "7z"],
};

export function categoryForExt(ext: string): string {
  const e = ext.toLowerCase();
  for (const [cat, exts] of Object.entries(CATEGORY_EXTS)) if (exts.includes(e)) return cat;
  return "file";
}

export type Classification = { ext: string; category: string };

/**
 * Extension + visual category for an object key. Keys are expected to carry a
 * real extension (the uploader guarantees it), so this is key-only — no
 * content-type inference, no HEAD requests.
 */
export function classify(key: string): Classification {
  const base = key.replace(/\/$/, "").split("/").pop() ?? "";
  const m = base.match(/[^.]\.([a-z0-9]{1,6})$/i); // require a non-dot char before .ext so dotfiles (.keep, .env) → no ext
  if (m) {
    const ext = m[1].toLowerCase();
    return { ext, category: categoryForExt(ext) };
  }
  return { ext: "", category: "file" };
}
