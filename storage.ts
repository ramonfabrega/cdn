// Storage layer for LOCAL (Bun) runtime. Talks to R2 over the S3 API using the
// same `passage` creds the `share` CLI uses.
//
// Runtime-specific half. When promoted to a Worker, this gets an R2-binding
// sibling with the same exported shape. `lib/cdn.ts` stays pure (imported by both).

import { classify, mimeFor, publicUrl } from "./lib/cdn.ts";
import { getR2Client as getClient } from "./r2-client.ts";

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
async function listAll(prefix = ""): Promise<RawObj[]> {
  const client = await getClient();
  const out: RawObj[] = [];
  let token: string | undefined;
  do {
    const res = await client.list({ prefix, maxKeys: 1000, continuationToken: token });
    for (const o of res.contents ?? []) {
      out.push({ key: o.key, size: o.size ?? 0, lastModified: o.lastModified ?? "" });
    }
    token = res.isTruncated ? res.nextContinuationToken : undefined;
  } while (token);
  return out;
}

// ── public API ───────────────────────────────────────────────────────────

/** Full object list for the bucket — the client builds the tree from this. */
export async function tree(): Promise<Entry[]> {
  const raws = await listAll("");
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
 * Create an (empty) folder. S3/R2 folders are virtual — a prefix exists only
 * while objects live under it. A trailing-slash marker key gets its slash
 * stripped by the list API, so we drop a hidden `.keep` object instead (the
 * classic trick). The UI hides `.keep`; folders with real content don't need it.
 */
export async function createFolder(prefix: string, name: string): Promise<string> {
  const clean = name.trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean.includes("/")) throw new Error("invalid folder name");
  const p = prefix ? prefix.replace(/\/?$/, "/") : "";
  const folder = `${p}${clean}/`;
  await (await getClient()).write(`${folder}.keep`, "", { type: "text/plain" });
  return folder;
}

/** Copy one object (no native S3 copy in Bun → read+write). Content-type from the key's extension. */
async function copyObject(from: string, to: string): Promise<void> {
  const client = await getClient();
  const buf = await client.file(from).arrayBuffer();
  await client.write(to, buf, { type: mimeFor(to) });
}

/** Copy+delete every object under `fromPrefix` to `toPrefix`. Shared by move + rename. */
async function relocatePrefix(fromPrefix: string, toPrefix: string): Promise<number> {
  if (toPrefix === fromPrefix) return 0;
  if (toPrefix.startsWith(fromPrefix)) throw new Error("cannot move a folder into itself");
  const client = await getClient();
  const objs = await listAll(fromPrefix);
  for (const o of objs) {
    await copyObject(o.key, toPrefix + o.key.slice(fromPrefix.length));
    await client.delete(o.key);
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
export async function move(from: string, to: string): Promise<number> {
  const dest = to ? to.replace(/\/?$/, "/") : "";
  if (from.endsWith("/")) {
    const name = from.replace(/\/$/, "").split("/").pop() ?? "";
    return relocatePrefix(from, `${dest}${name}/`);
  }
  const name = from.split("/").pop() ?? from;
  const newKey = `${dest}${name}`;
  if (newKey === from) return 0;
  await copyObject(from, newKey);
  await (await getClient()).delete(from);
  return 1;
}

/**
 * Rename a file or folder in place (same parent, new leaf name).
 * Same copy+delete mechanism as move. Returns objects affected.
 */
export async function rename(key: string, newName: string): Promise<number> {
  const clean = newName.trim().replace(/^\/+|\/+$/g, "");
  if (!clean || clean.includes("/")) throw new Error("invalid name");
  const parent = parentPrefix(key);
  if (key.endsWith("/")) return relocatePrefix(key, `${parent}${clean}/`);
  const newKey = `${parent}${clean}`;
  if (newKey === key) return 0;
  await copyObject(key, newKey);
  await (await getClient()).delete(key);
  return 1;
}

/** Delete a single object, or (if key ends in "/") a folder and everything under it. */
export async function remove(key: string): Promise<number> {
  const client = await getClient();
  if (key.endsWith("/")) {
    const objs = await listAll(key);
    for (const o of objs) await client.delete(o.key);
    return objs.length;
  }
  await client.delete(key);
  return 1;
}
