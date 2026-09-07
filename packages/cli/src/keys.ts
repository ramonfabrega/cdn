// How a local path becomes an object key. Pure, so the rules are testable
// without a server and readable without running anything.
//
// These rules predate the CLI — they are what the author's `share` script did and
// what `macos/quickshare` still does in bash — and they are here rather than in
// `client/` because they are the CLI's opinion, not the API's. The Worker takes
// whatever key you give it; each front end decides how a filename becomes one.
// The hooks, for instance, mint a hash of the path instead, because a re-mirror
// of the same artifact should overwrite rather than pile up.

import { readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";

/** Six hex characters, client-side. A public URL should not leak the local
    filename, and there is no reason to make the server responsible for naming. */
export const randomSlug = (len = 6) => crypto.randomUUID().replaceAll("-", "").slice(0, len);

/** Strip leading slashes: a key is relative to the bucket root, always. */
export const normalize = (key: string) => key.replace(/^\/+/, "");

/**
 * The key for a single file:
 *
 *   up shot.png                  → a1b2c3.png          random slug, real extension
 *   up shot.png notes/           → notes/a1b2c3.png    trailing slash = a namespace
 *   up shot.png notes/hero.png   → notes/hero.png      an explicit key wins
 *   up shot.png notes/hero       → notes/hero.png      no extension? take the source's
 *
 * The extension is never dropped, because the Worker types the object from it —
 * a key without one serves as application/octet-stream and downloads instead of
 * rendering.
 */
export const keyForFile = (src: string, dest?: string, slug = randomSlug): string => {
  const ext = extname(src);
  if (!dest) return normalize(slug() + ext);
  if (dest.endsWith("/")) return normalize(dest + slug() + ext);
  return normalize(extname(dest) ? dest : dest + ext);
};

/**
 * The prefix a directory's contents hang under:
 *
 *   up ./shots          → shots/     the directory's own name
 *   up ./shots notes/   → notes/     an explicit destination
 *
 * Always ends in a slash: a prefix that doesn't is a file key, and the Worker
 * serves any prefix as a public listing page, which is the point of uploading a
 * directory at all.
 */
export const prefixForDir = (src: string, dest?: string): string => {
  const root = src.replace(/\/+$/, "");
  const name = root.split("/").pop() || "files";
  return normalize((dest || `${name}/`).replace(/\/?$/, "/"));
};

/** The key one file inside a directory upload gets: the prefix plus its path
    relative to the root, so the tree survives the trip. */
export const keyInDir = (prefix: string, root: string, file: string): string =>
  normalize(prefix + relative(root.replace(/\/+$/, ""), file));

/** Names that are never worth uploading: macOS metadata and a repository's guts.
    Same list `share` and `quickshare` skip. */
const SKIP = new Set([".DS_Store", ".git"]);

/** Every file under `root`, depth-first, in a stable order. Sorted because an
    upload's progress output and its tests both read better when the order is the
    same twice, and `readdir` promises nothing. */
export async function walk(root: string): Promise<string[]> {
  const out: string[] = [];
  const descend = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (SKIP.has(e.name)) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) await descend(full);
      else if (e.isFile()) out.push(full);
    }
  };
  await descend(root.replace(/\/+$/, ""));
  return out;
}

/** Human sizes for the one line a person reads after uploading a directory. */
export const humanSize = (bytes: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let n = bytes;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  return `${u === 0 ? n : n.toFixed(1)} ${units[u]}`;
};
