import { describe, expect, test } from "vitest";

import { categoryForExt, classify, humanSize, mimeFor, publicUrl, randomKey } from "./cdn.ts";

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
    expect(mimeFor("x.html")).toBe("text/html");
    expect(mimeFor("x.weird")).toBe("application/octet-stream");
    expect(mimeFor("noext")).toBe("application/octet-stream");
  });
});

describe("publicUrl", () => {
  test("builds CDN url and strips a leading slash", () => {
    expect(publicUrl("a/b.png")).toBe("https://cdn.ramonfabrega.com/a/b.png");
    expect(publicUrl("/a.png")).toBe("https://cdn.ramonfabrega.com/a.png");
  });
});

describe("humanSize", () => {
  test("formats bytes", () => {
    expect(humanSize(0)).toBe("0 B");
    expect(humanSize(512)).toBe("512 B");
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("randomKey", () => {
  test("6 lowercase hex chars, no dashes", () => {
    expect(randomKey()).toMatch(/^[0-9a-f]{6}$/);
  });
  test("custom length", () => {
    expect(randomKey(10)).toMatch(/^[0-9a-f]{10}$/);
  });
});
