// Storage layer for the Worker runtime. Talks to R2 through the binding
// (`env.BUCKET`, an R2Bucket) — no S3 client, no `passage`, no Bun.
//
// Every op takes the bucket explicitly because on a Worker the binding lives on
// the per-request `env`, not a module global. The `share` CLI uploads through the
// Worker (POST /api/upload), so there's no S3 client anywhere anymore.

import { classify, mimeFor, publicUrl } from "./lib/cdn.ts";

export type Entry = {
  key: string;
  size: number;
  lastModified: string;
  ext: string;
  category: string;
  url: string;
};

type RawObj = { key: string; size: number; lastModified: string };

/** Every object under `prefix` (no delimiter), following pagination. */
async function listAll(bucket: R2Bucket, prefix = ""): Promise<RawObj[]> {
  const out: RawObj[] = [];
  let cursor: string | undefined;
  do {
    const res = await bucket.list({ prefix, limit: 1000, cursor });
    for (const o of res.objects) {
      out.push({ key: o.key, size: o.size, lastModified: o.uploaded.toISOString() });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

// ── public API ───────────────────────────────────────────────────────────

/** Full object list for the bucket — the client builds the tree from this. */
export async function tree(bucket: R2Bucket): Promise<Entry[]> {
  const raws = await listAll(bucket);
  return raws.map((o) => {
    const c = classify(o.key);
    return {
      key: o.key,
      size: o.size,
      lastModified: o.lastModified,
      ext: c.ext,
      category: c.category,
      url: publicUrl(o.key),
    };
  });
}

/**
 * Create an (empty) folder. R2 folders are virtual — a prefix exists only while
 * objects live under it. A trailing-slash marker key gets its slash stripped by
 * the list API, so we drop a hidden `.keep` object instead (the classic trick).
 * The UI hides `.keep`; folders with real content don't need it.
 */
export async function createFolder(
  bucket: R2Bucket,
  prefix: string,
  name: string
): Promise<string> {
  const clean = name.trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean.includes("/")) throw new Error("invalid folder name");
  const p = prefix ? prefix.replace(/\/?$/, "/") : "";
  const folder = `${p}${clean}/`;
  await bucket.put(`${folder}.keep`, "", { httpMetadata: { contentType: "text/plain" } });
  return folder;
}

/** Copy one object (R2 has no native binding copy → get+put). Content-type from the key's extension. */
async function copyObject(bucket: R2Bucket, from: string, to: string): Promise<void> {
  const obj = await bucket.get(from);
  if (!obj) throw new Error(`missing object: ${from}`);
  await bucket.put(to, await obj.arrayBuffer(), { httpMetadata: { contentType: mimeFor(to) } });
}

/** Copy+delete every object under `fromPrefix` to `toPrefix`. Shared by move + rename. */
async function relocatePrefix(
  bucket: R2Bucket,
  fromPrefix: string,
  toPrefix: string
): Promise<number> {
  if (toPrefix === fromPrefix) return 0;
  if (toPrefix.startsWith(fromPrefix)) throw new Error("cannot move a folder into itself");
  const objs = await listAll(bucket, fromPrefix);
  for (const o of objs) {
    await copyObject(bucket, o.key, toPrefix + o.key.slice(fromPrefix.length));
    await bucket.delete(o.key);
  }
  return objs.length;
}

/** Parent prefix of a key: "a/b/c.png" -> "a/b/", "a/b/" -> "a/", root -> "". */
function parentPrefix(key: string): string {
  const k = key.replace(/\/$/, "");
  const i = k.lastIndexOf("/");
  return i === -1 ? "" : k.slice(0, i + 1);
}

/**
 * Move a file or folder into destination folder prefix `to` ("" = root),
 * keeping its name. copy+delete (no native copy). Returns objects moved.
 */
export async function move(bucket: R2Bucket, from: string, to: string): Promise<number> {
  const dest = to ? to.replace(/\/?$/, "/") : "";
  if (from.endsWith("/")) {
    const name = from.replace(/\/$/, "").split("/").pop() ?? "";
    return relocatePrefix(bucket, from, `${dest}${name}/`);
  }
  const name = from.split("/").pop() ?? from;
  const newKey = `${dest}${name}`;
  if (newKey === from) return 0;
  await copyObject(bucket, from, newKey);
  await bucket.delete(from);
  return 1;
}

/**
 * Rename a file or folder in place (same parent, new leaf name).
 * Same copy+delete mechanism as move. Returns objects affected.
 */
export async function rename(bucket: R2Bucket, key: string, newName: string): Promise<number> {
  const clean = newName.trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean.includes("/")) throw new Error("invalid name");
  const parent = parentPrefix(key);
  if (key.endsWith("/")) return relocatePrefix(bucket, key, `${parent}${clean}/`);
  const newKey = `${parent}${clean}`;
  if (newKey === key) return 0;
  await copyObject(bucket, key, newKey);
  await bucket.delete(key);
  return 1;
}

/** Delete a single object, or (if key ends in "/") a folder and everything under it. */
export async function remove(bucket: R2Bucket, key: string): Promise<number> {
  if (key.endsWith("/")) {
    const objs = await listAll(bucket, key);
    if (objs.length) await bucket.delete(objs.map((o) => o.key));
    return objs.length;
  }
  await bucket.delete(key);
  return 1;
}
