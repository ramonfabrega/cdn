// Storage layer for the Worker runtime. Talks to R2 through the binding
// (`env.BUCKET`, an R2Bucket) — no S3 client, no `passage`, no Bun.
//
// Every op takes the bucket explicitly because on a Worker the binding lives on
// the per-request `env`, not a module global. The `share` CLI uploads through the
// Worker (POST /api/upload), so there's no S3 client anywhere anymore.
//
// Expiry lives HERE, not in an R2 lifecycle rule: `sweep()` (run by the Worker's
// daily cron) deletes objects older than EXPIRY_DAYS unless they carry the
// `permanent` customMetadata flag. R2 lifecycle rules are prefix-only and can't
// express per-object exemptions, so the bucket's blanket 30d rule was retired in
// favor of this sweep.

import { classify, mimeFor, publicUrl } from "./lib/cdn.ts";

export type Entry = {
  key: string;
  size: number;
  lastModified: string;
  ext: string;
  category: string;
  url: string;
  permanent: boolean;
};

/** Objects affected by a mutation + every key whose cached public URL is now stale. */
export type Mutation = { count: number; purge: string[] };

type RawObj = { key: string; size: number; lastModified: string; permanent: boolean };

/** Every object under `prefix` (no delimiter), following pagination. */
async function listAll(bucket: R2Bucket, prefix = ""): Promise<RawObj[]> {
  const out: RawObj[] = [];
  let cursor: string | undefined;
  do {
    const res = await bucket.list({ prefix, limit: 1000, cursor, include: ["customMetadata"] });
    for (const o of res.objects) {
      out.push({
        key: o.key,
        size: o.size,
        lastModified: o.uploaded.toISOString(),
        permanent: o.customMetadata?.permanent === "1",
      });
    }
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return out;
}

// ── public API ───────────────────────────────────────────────────────────

/** One level of a folder: files directly under `prefix` + the immediate
    subfolder prefixes (delimited list). `.keep` markers are hidden. This feeds
    the PUBLIC folder share pages, so it never lists recursively. `origin` is the
    requesting host's URL.origin — Entry.url must stay on the host that asked
    (custom domain, preview build, dev), see publicUrl. */
export type FolderListing = { files: Entry[]; folders: string[] };
export async function listFolder(
  bucket: R2Bucket,
  prefix: string,
  origin: string
): Promise<FolderListing> {
  const files: Entry[] = [];
  const folders = new Set<string>();
  let cursor: string | undefined;
  do {
    const res = await bucket.list({ prefix, delimiter: "/", limit: 1000, cursor });
    for (const o of res.objects) {
      if (o.key.endsWith("/") || o.key.endsWith("/.keep") || o.key === ".keep") continue;
      const c = classify(o.key);
      files.push({
        key: o.key,
        size: o.size,
        lastModified: o.uploaded.toISOString(),
        ext: c.ext,
        category: c.category,
        url: publicUrl(origin, o.key),
        permanent: false, // not fetched (no customMetadata include) — the public page doesn't show it
      });
    }
    for (const p of res.delimitedPrefixes) folders.add(p);
    cursor = res.truncated ? res.cursor : undefined;
  } while (cursor);
  return { files, folders: [...folders].sort() };
}

/** Flat subtree under a prefix — keys + sizes only, first list page (≤1000
    objects). Feeds the og:image card's sunburst; a card needs shape, not
    completeness, so no pagination. */
export type SubtreeEntry = { key: string; size: number };
export async function listSubtree(bucket: R2Bucket, prefix: string): Promise<SubtreeEntry[]> {
  const res = await bucket.list({ prefix, limit: 1000 });
  return res.objects
    .filter((o) => !o.key.endsWith("/") && !o.key.endsWith("/.keep") && o.key !== ".keep")
    .map((o) => ({ key: o.key, size: o.size }));
}

/** Full object list for the bucket — the client builds the tree from this.
    `origin` as in listFolder: urls stay on the requesting host. */
export async function tree(bucket: R2Bucket, origin: string): Promise<Entry[]> {
  const raws = await listAll(bucket);
  return raws.map((o) => {
    const c = classify(o.key);
    return {
      key: o.key,
      size: o.size,
      lastModified: o.lastModified,
      ext: c.ext,
      category: c.category,
      url: publicUrl(origin, o.key),
      permanent: o.permanent,
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

/** Copy one object (R2 has no native binding copy → get+put). Content-type from
    the key's extension; customMetadata (the `permanent` flag) travels with it. */
async function copyObject(bucket: R2Bucket, from: string, to: string): Promise<void> {
  const obj = await bucket.get(from);
  if (!obj) throw new Error(`missing object: ${from}`);
  await bucket.put(to, await obj.arrayBuffer(), {
    httpMetadata: { contentType: mimeFor(to) },
    customMetadata: obj.customMetadata,
  });
}

/** Copy+delete every object under `fromPrefix` to `toPrefix`. Shared by move + rename. */
async function relocatePrefix(
  bucket: R2Bucket,
  fromPrefix: string,
  toPrefix: string
): Promise<Mutation> {
  if (toPrefix === fromPrefix) return { count: 0, purge: [] };
  if (toPrefix.startsWith(fromPrefix)) throw new Error("cannot move a folder into itself");
  const objs = await listAll(bucket, fromPrefix);
  const purge: string[] = [];
  for (const o of objs) {
    const to = toPrefix + o.key.slice(fromPrefix.length);
    await copyObject(bucket, o.key, to);
    await bucket.delete(o.key);
    purge.push(o.key, to);
  }
  return { count: objs.length, purge };
}

/** Parent prefix of a key: "a/b/c.png" -> "a/b/", "a/b/" -> "a/", root -> "". */
function parentPrefix(key: string): string {
  const k = key.replace(/\/$/, "");
  const i = k.lastIndexOf("/");
  return i === -1 ? "" : k.slice(0, i + 1);
}

/**
 * Move a file or folder into destination folder prefix `to` ("" = root),
 * keeping its name. copy+delete (no native copy).
 */
export async function move(bucket: R2Bucket, from: string, to: string): Promise<Mutation> {
  const dest = to ? to.replace(/\/?$/, "/") : "";
  if (from.endsWith("/")) {
    const name = from.replace(/\/$/, "").split("/").pop() ?? "";
    return relocatePrefix(bucket, from, `${dest}${name}/`);
  }
  const name = from.split("/").pop() ?? from;
  const newKey = `${dest}${name}`;
  if (newKey === from) return { count: 0, purge: [] };
  await copyObject(bucket, from, newKey);
  await bucket.delete(from);
  return { count: 1, purge: [from, newKey] };
}

/**
 * Rename a file or folder in place (same parent, new leaf name).
 * Same copy+delete mechanism as move.
 */
export async function rename(bucket: R2Bucket, key: string, newName: string): Promise<Mutation> {
  const clean = newName.trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean.includes("/")) throw new Error("invalid name");
  const parent = parentPrefix(key);
  if (key.endsWith("/")) return relocatePrefix(bucket, key, `${parent}${clean}/`);
  const newKey = `${parent}${clean}`;
  if (newKey === key) return { count: 0, purge: [] };
  await copyObject(bucket, key, newKey);
  await bucket.delete(key);
  return { count: 1, purge: [key, newKey] };
}

/** Delete a single object, or (if key ends in "/") a folder and everything under it. */
export async function remove(bucket: R2Bucket, key: string): Promise<Mutation> {
  if (key.endsWith("/")) {
    const keys = (await listAll(bucket, key)).map((o) => o.key);
    if (keys.length) await bucket.delete(keys);
    return { count: keys.length, purge: keys };
  }
  await bucket.delete(key);
  return { count: 1, purge: [key] };
}

/**
 * Flip the `permanent` flag — a flagged object is exempt from the expiry sweep.
 * R2 has no metadata-only update, so this rewrites the object in place (same
 * bytes). The rewrite resets `uploaded`, so un-flagging also restarts the 30d clock.
 */
export async function setPermanent(
  bucket: R2Bucket,
  key: string,
  permanent: boolean
): Promise<void> {
  if (!key || key.endsWith("/")) throw new Error("permanence applies to files, not folders");
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`missing object: ${key}`);
  const meta = { ...obj.customMetadata };
  if (permanent) meta.permanent = "1";
  else delete meta.permanent;
  await bucket.put(key, await obj.arrayBuffer(), {
    httpMetadata: obj.httpMetadata,
    customMetadata: meta,
  });
}

/**
 * Expiry sweep (run by the Worker's daily cron): delete every object uploaded
 * more than EXPIRY_DAYS ago, unless it's `permanent`. Overwriting a key resets
 * its clock (R2 `uploaded` is per-version). Returns the deleted keys.
 */
export const EXPIRY_DAYS = 30;
export async function sweep(bucket: R2Bucket, now = Date.now()): Promise<string[]> {
  const cutoff = now - EXPIRY_DAYS * 86_400_000;
  const expired = (await listAll(bucket))
    .filter((o) => !o.permanent && Date.parse(o.lastModified) < cutoff)
    .map((o) => o.key);
  for (let i = 0; i < expired.length; i += 1000) {
    await bucket.delete(expired.slice(i, i + 1000)); // batch delete caps at 1000 keys
  }
  return expired;
}
