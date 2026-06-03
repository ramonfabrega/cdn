// Pure, dependency-free helpers for the cdn Worker: key → MIME content-typing and
// key → { ext, category } classification (the explorer's badges + the content-type
// stored on upload). No external deps, no runtime-specific APIs — just string ops —
// so it's trivially testable and keeps the Worker bundle lean. The `share` CLI used
// to import from here; it now owns its own tiny helpers, so this module is
// Worker-internal.

export const DOMAIN = "cdn.ramonfabrega.com";

/** Lowercased extension of a path incl. the dot (".png"), or "" — matches node's
    extname (leading-dot files like ".keep" have no extension). Inlined to keep
    this module dependency-free. */
function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

/** Extension -> MIME type. Anything not here falls back to octet-stream. */
export const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".json": "application/json",
  ".css": "text/css",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".txt": "text/plain",
  ".md": "text/plain",
};

/** Pick a content-type from a path/key extension. */
export function mimeFor(path: string): string {
  return MIME_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

/** Public URL for an object key. */
export function publicUrl(key: string): string {
  return `https://${DOMAIN}/${key.replace(/^\//, "")}`;
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
