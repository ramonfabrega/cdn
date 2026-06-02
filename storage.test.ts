// Integration tests against the REAL R2 bucket, isolated under a unique
// `__test__/<uuid>/` prefix and torn down in afterAll. Run with: bun test
//
// These deliberately hit live R2 (not a mock) because the bugs worth catching
// are R2/Bun-S3 behaviors — trailing-slash handling, content-type on copy, etc.

import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import type { S3Client } from "bun";
import { getR2Client } from "./r2-client.ts";
import { tree, createFolder, move, rename, remove } from "./storage.ts";

const PREFIX = `__test__/${crypto.randomUUID().slice(0, 8)}/`;
let client: S3Client;

const put = (key: string, body: any, type: string) => client.write(key, body, { type });
async function exists(key: string) { try { await client.stat(key); return true; } catch { return false; } }
async function typeOf(key: string) { try { return (await client.stat(key)).type; } catch { return null; } }

beforeAll(async () => { client = await getR2Client(); });
afterAll(async () => { await remove(PREFIX); }); // recursive delete of the whole test prefix

describe("createFolder", () => {
  test("makes an empty folder visible via a hidden .keep marker", async () => {
    const folder = await createFolder(PREFIX, "empty");
    expect(folder).toBe(`${PREFIX}empty/`);
    expect(await exists(`${PREFIX}empty/.keep`)).toBe(true);
  });
  test("rejects names containing a slash", () => {
    expect(createFolder(PREFIX, "a/b")).rejects.toThrow(/invalid folder name/);
  });
});

describe("tree", () => {
  test("classifies objects by extension and builds the public URL", async () => {
    await put(`${PREFIX}t/pic.png`, "x", "image/png");
    const entry = (await tree()).find((o) => o.key === `${PREFIX}t/pic.png`);
    expect(entry).toBeDefined();
    expect(entry!.ext).toBe("png");
    expect(entry!.category).toBe("image");
    expect(entry!.url).toBe(`https://cdn.ramonfabrega.com/${PREFIX}t/pic.png`);
  });
});

describe("move", () => {
  test("moves a file and sets content-type from the destination extension", async () => {
    await put(`${PREFIX}a/hero.png`, new Uint8Array([1, 2, 3]), "image/png");
    expect(await move(`${PREFIX}a/hero.png`, `${PREFIX}b`)).toBe(1);
    expect(await exists(`${PREFIX}a/hero.png`)).toBe(false);
    expect(await exists(`${PREFIX}b/hero.png`)).toBe(true);
    expect(await typeOf(`${PREFIX}b/hero.png`)).toBe("image/png");
  });
  test("moves a folder, remapping every object beneath it", async () => {
    await put(`${PREFIX}src/one.txt`, "1", "text/plain");
    await put(`${PREFIX}src/sub/two.txt`, "2", "text/plain");
    expect(await move(`${PREFIX}src/`, `${PREFIX}dst`)).toBe(2);
    expect(await exists(`${PREFIX}dst/src/one.txt`)).toBe(true);
    expect(await exists(`${PREFIX}dst/src/sub/two.txt`)).toBe(true);
    expect(await exists(`${PREFIX}src/one.txt`)).toBe(false);
  });
  test("rejects moving a folder into itself", async () => {
    await createFolder(PREFIX, "self");
    expect(move(`${PREFIX}self/`, `${PREFIX}self`)).rejects.toThrow(/into itself/);
  });
});

describe("rename", () => {
  test("renames a file in place", async () => {
    await put(`${PREFIX}r/old.json`, "{}", "application/json");
    expect(await rename(`${PREFIX}r/old.json`, "new.json")).toBe(1);
    expect(await exists(`${PREFIX}r/old.json`)).toBe(false);
    expect(await exists(`${PREFIX}r/new.json`)).toBe(true);
  });
  test("renames a folder, remapping its contents", async () => {
    await put(`${PREFIX}f1/x.txt`, "x", "text/plain");
    expect(await rename(`${PREFIX}f1/`, "f2")).toBe(1);
    expect(await exists(`${PREFIX}f2/x.txt`)).toBe(true);
    expect(await exists(`${PREFIX}f1/x.txt`)).toBe(false);
  });
  test("rejects a name containing a slash", async () => {
    await put(`${PREFIX}r2/a.txt`, "a", "text/plain");
    expect(rename(`${PREFIX}r2/a.txt`, "a/b")).rejects.toThrow(/invalid name/);
  });
});

describe("remove", () => {
  test("deletes a single object", async () => {
    await put(`${PREFIX}d/one.txt`, "1", "text/plain");
    expect(await remove(`${PREFIX}d/one.txt`)).toBe(1);
    expect(await exists(`${PREFIX}d/one.txt`)).toBe(false);
  });
  test("recursively deletes a folder and everything under it", async () => {
    await put(`${PREFIX}d2/a.txt`, "a", "text/plain");
    await put(`${PREFIX}d2/sub/b.txt`, "b", "text/plain");
    expect(await remove(`${PREFIX}d2/`)).toBe(2);
    expect(await exists(`${PREFIX}d2/a.txt`)).toBe(false);
    expect(await exists(`${PREFIX}d2/sub/b.txt`)).toBe(false);
  });
});
