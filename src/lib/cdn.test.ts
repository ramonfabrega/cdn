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

  test("percent-encodes each segment but keeps slashes", () => {
    expect(publicUrl("Screenshot 2026-07-09 at 6.15.20 PM.png")).toBe(
      "https://cdn.ramonfabrega.com/Screenshot%202026-07-09%20at%206.15.20%E2%80%AFPM.png"
    );
    expect(publicUrl("dir with spaces/file#1.png")).toBe(
      "https://cdn.ramonfabrega.com/dir%20with%20spaces/file%231.png"
    );
  });
});
