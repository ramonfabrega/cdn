// Pure helpers shared by the `share` CLI and the cdn explorer.
//
// HARD RULE: zero external deps and no runtime-specific imports here
// (no `import "bun"`, no Worker APIs). Only Node stdlib + global Web APIs,
// which exist in both Bun and Cloudflare Workers. This keeps `bin/share`
// zero-install and lets the same lib survive the Bun -> Worker promotion.

export const DOMAIN = "cdn.ramonfabrega.com";
export const BUCKET = "cdn";

/** Lowercased extension of a path incl. the dot (".png"), or "" — matches node's
    extname (leading-dot files like ".keep" have no extension). Inlined so this
    file stays dependency-free and runs unchanged on Bun and Workers. */
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

/** A short random object key, e.g. "a1b2c3". */
export function randomKey(len = 6): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, len);
}

/** Public URL for an object key. */
export function publicUrl(key: string): string {
  return `https://${DOMAIN}/${key.replace(/^\//, "")}`;
}

/** Human-readable byte size, e.g. 1536 -> "1.5 KB". */
export function humanSize(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${u === 0 ? n : n.toFixed(1)} ${units[u]}`;
}

// ── type classification (shared by explorer badges + CLI) ──────────────────

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
