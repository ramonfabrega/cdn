// Integration tests for the storage layer against a local Miniflare R2 (the
// BUCKET binding), via @cloudflare/vitest-pool-workers. Hermetic and fast — no
// real R2, no `passage`. Storage is rolled back between tests (isolatedStorage),
// so each test sets up its own fixtures. Run with: bun run test

import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";

import { createFolder, move, remove, rename, tree } from "./storage.ts";

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
    expect(await move(bucket, `${P}a/hero.png`, `${P}b`)).toBe(1);
    expect(await exists(`${P}a/hero.png`)).toBe(false);
    expect(await exists(`${P}b/hero.png`)).toBe(true);
    expect(await typeOf(`${P}b/hero.png`)).toBe("image/png");
  });
  test("moves a folder, remapping every object beneath it", async () => {
    await put(`${P}src/one.txt`, "1", "text/plain");
    await put(`${P}src/sub/two.txt`, "2", "text/plain");
    expect(await move(bucket, `${P}src/`, `${P}dst`)).toBe(2);
    expect(await exists(`${P}dst/src/one.txt`)).toBe(true);
    expect(await exists(`${P}dst/src/sub/two.txt`)).toBe(true);
    expect(await exists(`${P}src/one.txt`)).toBe(false);
  });
  test("rejects moving a folder into itself", async () => {
    await createFolder(bucket, P, "self");
    expect(move(bucket, `${P}self/`, `${P}self`)).rejects.toThrow(/into itself/);
  });
});

describe("rename", () => {
  test("renames a file in place", async () => {
    await put(`${P}r/old.json`, "{}", "application/json");
    expect(await rename(bucket, `${P}r/old.json`, "new.json")).toBe(1);
    expect(await exists(`${P}r/old.json`)).toBe(false);
    expect(await exists(`${P}r/new.json`)).toBe(true);
  });
  test("renames a folder, remapping its contents", async () => {
    await put(`${P}f1/x.txt`, "x", "text/plain");
    expect(await rename(bucket, `${P}f1/`, "f2")).toBe(1);
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
    expect(await remove(bucket, `${P}d/one.txt`)).toBe(1);
    expect(await exists(`${P}d/one.txt`)).toBe(false);
  });
  test("recursively deletes a folder and everything under it", async () => {
    await put(`${P}d2/a.txt`, "a", "text/plain");
    await put(`${P}d2/sub/b.txt`, "b", "text/plain");
    expect(await remove(bucket, `${P}d2/`)).toBe(2);
    expect(await exists(`${P}d2/a.txt`)).toBe(false);
    expect(await exists(`${P}d2/sub/b.txt`)).toBe(false);
  });
});
