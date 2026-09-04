import { describe, expect, test } from "vitest";

import { categoryForExt, classify, mimeFor, publicUrl } from "./cdn.ts";

describe("classify", () => {
  test("by extension", () => {
    expect(classify("a/b/hero.png")).toEqual({ ext: "png", category: "image" });
    expect(classify("demo.html")).toEqual({ ext: "html", category: "html" });
    expect(classify("data.json")).toEqual({ ext: "json", category: "code" });
    expect(classify("notes.md")).toEqual({ ext: "md", category: "text" });
    expect(classify("clip.mp4")).toEqual({ ext: "mp4", category: "video" });
  });
  test("extension-less / folder keys → file", () => {
    expect(classify("slug")).toEqual({ ext: "", category: "file" });
    expect(classify("a/b/")).toEqual({ ext: "", category: "file" });
    expect(classify("a/b/.keep")).toEqual({ ext: "", category: "file" });
  });
  test("uppercase extensions normalize", () => {
    expect(classify("IMG.PNG")).toEqual({ ext: "png", category: "image" });
  });
});

describe("categoryForExt", () => {
  test("known + unknown", () => {
    expect(categoryForExt("svg")).toBe("image");
    expect(categoryForExt("zip")).toBe("archive");
    expect(categoryForExt("xyz")).toBe("file");
  });
});

describe("mimeFor", () => {
  test("known extensions + octet-stream fallback", () => {
    expect(mimeFor("x.png")).toBe("image/png");
    expect(mimeFor("x.html")).toBe("text/html; charset=utf-8");
    expect(mimeFor("x.weird")).toBe("application/octet-stream");
    expect(mimeFor("noext")).toBe("application/octet-stream");
  });

  // A Sparkle appcast is the most-read .xml on the CDN and it used to serve as
  // octet-stream, i.e. a download prompt instead of a readable feed. Typing it
  // costs nothing (serving re-derives from the key) and Sparkle never looks.
  test("xml renders instead of downloading", () => {
    expect(mimeFor("ccc/appcast.xml")).toBe("application/xml; charset=utf-8");
  });

  // The mojibake guard: a .md/.txt served as bare "text/plain" gets decoded as
  // latin-1, so every em-dash in a shared note turns into â€”. Text-ish types
  // must carry the charset; binary ones must not (a charset on image/png is
  // meaningless noise).
  test("text-ish types carry charset=utf-8, binary ones don't", () => {
    for (const ext of ["md", "txt", "html", "htm", "css", "js", "mjs", "json", "svg", "xml"])
      expect(mimeFor(`x.${ext}`)).toMatch(/; charset=utf-8$/);
    for (const ext of ["png", "jpg", "gif", "webp", "pdf", "mp4", "mov", "weird"])
      expect(mimeFor(`x.${ext}`)).not.toContain("charset");
  });
});

describe("publicUrl", () => {
  test("builds CDN url and strips a leading slash", () => {
    expect(publicUrl("https://cdn.test", "a/b.png")).toBe("https://cdn.test/a/b.png");
    expect(publicUrl("https://cdn.test", "/a.png")).toBe("https://cdn.test/a.png");
  });

  test("percent-encodes each segment but keeps slashes", () => {
    expect(publicUrl("https://cdn.test", "Screenshot 2026-07-09 at 6.15.20 PM.png")).toBe(
      "https://cdn.test/Screenshot%202026-07-09%20at%206.15.20%E2%80%AFPM.png"
    );
    expect(publicUrl("https://cdn.test", "dir with spaces/file#1.png")).toBe(
      "https://cdn.test/dir%20with%20spaces/file%231.png"
    );
  });
});
