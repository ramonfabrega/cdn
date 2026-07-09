// Integration tests for the storage layer against a local Miniflare R2 (the
// BUCKET binding), via @cloudflare/vitest-pool-workers. Hermetic and fast — no
// real R2, no `passage`. Storage is rolled back between tests (isolatedStorage),
// so each test sets up its own fixtures. Run with: bun run test

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import {
  createFolder,
  EXPIRY_DAYS,
  move,
  remove,
  rename,
  setPermanent,
  sweep,
  tree,
} from "./storage.ts";

const bucket = env.BUCKET;
const P = "t/"; // namespace test keys (cosmetic; storage resets per test anyway)

const put = (key: string, body: string | Uint8Array, type: string) =>
  bucket.put(key, body, { httpMetadata: { contentType: type } });
const exists = async (key: string) => (await bucket.head(key)) !== null;
const typeOf = async (key: string) => (await bucket.head(key))?.httpMetadata?.contentType ?? null;

describe("createFolder", () => {
  test("makes an empty folder visible via a hidden .keep marker", async () => {
    const folder = await createFolder(bucket, P, "empty");
    expect(folder).toBe(`${P}empty/`);
    expect(await exists(`${P}empty/.keep`)).toBe(true);
  });
  test("rejects names containing a slash", () => {
    expect(createFolder(bucket, P, "a/b")).rejects.toThrow(/invalid folder name/);
  });
});

describe("tree", () => {
  test("classifies objects by extension and builds the public URL", async () => {
    await put(`${P}pic.png`, "x", "image/png");
    const entry = (await tree(bucket)).find((o) => o.key === `${P}pic.png`);
    expect(entry).toBeDefined();
    expect(entry?.ext).toBe("png");
    expect(entry?.category).toBe("image");
    expect(entry?.url).toBe(`https://cdn.ramonfabrega.com/${P}pic.png`);
  });
});

describe("move", () => {
  test("moves a file and sets content-type from the destination extension", async () => {
    await put(`${P}a/hero.png`, new Uint8Array([1, 2, 3]), "image/png");
    const m = await move(bucket, `${P}a/hero.png`, `${P}b`);
    expect(m.count).toBe(1);
    expect(m.purge).toEqual([`${P}a/hero.png`, `${P}b/hero.png`]);
    expect(await exists(`${P}a/hero.png`)).toBe(false);
    expect(await exists(`${P}b/hero.png`)).toBe(true);
    expect(await typeOf(`${P}b/hero.png`)).toBe("image/png");
  });
  test("moves a folder, remapping every object beneath it", async () => {
    await put(`${P}src/one.txt`, "1", "text/plain");
    await put(`${P}src/sub/two.txt`, "2", "text/plain");
    expect((await move(bucket, `${P}src/`, `${P}dst`)).count).toBe(2);
    expect(await exists(`${P}dst/src/one.txt`)).toBe(true);
    expect(await exists(`${P}dst/src/sub/two.txt`)).toBe(true);
    expect(await exists(`${P}src/one.txt`)).toBe(false);
  });
  test("carries the permanent flag along", async () => {
    await put(`${P}a/keep.txt`, "k", "text/plain");
    await setPermanent(bucket, `${P}a/keep.txt`, true);
    await move(bucket, `${P}a/keep.txt`, `${P}b`);
    expect((await bucket.head(`${P}b/keep.txt`))?.customMetadata?.permanent).toBe("1");
  });
  test("rejects moving a folder into itself", async () => {
    await createFolder(bucket, P, "self");
    expect(move(bucket, `${P}self/`, `${P}self`)).rejects.toThrow(/into itself/);
  });
});

describe("rename", () => {
  test("renames a file in place", async () => {
    await put(`${P}r/old.json`, "{}", "application/json");
    expect((await rename(bucket, `${P}r/old.json`, "new.json")).count).toBe(1);
    expect(await exists(`${P}r/old.json`)).toBe(false);
    expect(await exists(`${P}r/new.json`)).toBe(true);
  });
  test("renames a folder, remapping its contents", async () => {
    await put(`${P}f1/x.txt`, "x", "text/plain");
    expect((await rename(bucket, `${P}f1/`, "f2")).count).toBe(1);
    expect(await exists(`${P}f2/x.txt`)).toBe(true);
    expect(await exists(`${P}f1/x.txt`)).toBe(false);
  });
  test("rejects a name containing a slash", async () => {
    await put(`${P}r2/a.txt`, "a", "text/plain");
    expect(rename(bucket, `${P}r2/a.txt`, "a/b")).rejects.toThrow(/invalid name/);
  });
});

describe("remove", () => {
  test("deletes a single object", async () => {
    await put(`${P}d/one.txt`, "1", "text/plain");
    const m = await remove(bucket, `${P}d/one.txt`);
    expect(m.count).toBe(1);
    expect(m.purge).toEqual([`${P}d/one.txt`]);
    expect(await exists(`${P}d/one.txt`)).toBe(false);
  });
  test("recursively deletes a folder and everything under it", async () => {
    await put(`${P}d2/a.txt`, "a", "text/plain");
    await put(`${P}d2/sub/b.txt`, "b", "text/plain");
    expect((await remove(bucket, `${P}d2/`)).count).toBe(2);
    expect(await exists(`${P}d2/a.txt`)).toBe(false);
    expect(await exists(`${P}d2/sub/b.txt`)).toBe(false);
  });
});

describe("permanent + sweep", () => {
  const DAY = 86_400_000;

  test("setPermanent flags and unflags in place, keeping bytes + content-type", async () => {
    await put(`${P}mux/app.zip`, new Uint8Array([9, 9]), "application/zip");
    await setPermanent(bucket, `${P}mux/app.zip`, true);
    const flagged = await bucket.get(`${P}mux/app.zip`);
    expect(flagged?.customMetadata?.permanent).toBe("1");
    expect([...new Uint8Array((await flagged?.arrayBuffer()) ?? new ArrayBuffer(0))]).toEqual([
      9, 9,
    ]);
    await setPermanent(bucket, `${P}mux/app.zip`, false);
    expect((await bucket.head(`${P}mux/app.zip`))?.customMetadata?.permanent).toBeUndefined();
  });

  test("setPermanent rejects folders and missing keys", async () => {
    await expect(setPermanent(bucket, `${P}nope/`, true)).rejects.toThrow(/files/);
    await expect(setPermanent(bucket, `${P}ghost.txt`, true)).rejects.toThrow(/missing/);
  });

  test("tree exposes the permanent flag", async () => {
    await put(`${P}x.txt`, "x", "text/plain");
    await setPermanent(bucket, `${P}x.txt`, true);
    expect((await tree(bucket)).find((o) => o.key === `${P}x.txt`)?.permanent).toBe(true);
  });

  test("sweep deletes expired objects but never permanent ones", async () => {
    await put(`${P}old.txt`, "o", "text/plain");
    await put(`${P}forever.txt`, "f", "text/plain");
    await setPermanent(bucket, `${P}forever.txt`, true);
    // Miniflare stamps `uploaded` with real now — simulate age by sweeping from the future.
    const future = Date.now() + (EXPIRY_DAYS + 1) * DAY;
    const deleted = await sweep(bucket, future);
    expect(deleted).toContain(`${P}old.txt`);
    expect(deleted).not.toContain(`${P}forever.txt`);
    expect(await exists(`${P}old.txt`)).toBe(false);
    expect(await exists(`${P}forever.txt`)).toBe(true);
  });

  test("sweep leaves everything younger than the cutoff alone", async () => {
    await put(`${P}fresh.txt`, "f", "text/plain");
    expect(await sweep(bucket)).toEqual([]);
    expect(await exists(`${P}fresh.txt`)).toBe(true);
  });
});
