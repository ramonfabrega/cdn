// The og:image card is a pure node tree until takumi rasterizes it (worker.ts
// hands it to ImageResponse), so its content is testable without decoding a PNG
// — which is the only cheap way to assert on text that ends up as pixels.

import { describe, expect, test } from "vitest";

import { folderCard } from "./card.ts";
import type { Entry } from "./storage.ts";

const entry = (key: string, size = 3): Entry => ({
  key,
  url: `https://drop.example.org/${key}`,
  size,
  lastModified: "2026-09-07T00:00:00.000Z",
  ext: key.split(".").pop() ?? "",
  category: "file",
  permanent: false,
});

// Everything the card draws is either the prefix or the host it was rendered on;
// nothing about the card is configured, so a fork's unfurls carry the fork's
// domain and a preview link never advertises production.
const flatten = (node: unknown): string => JSON.stringify(node);

describe("folderCard", () => {
  test("stamps the request host, not a baked-in domain", () => {
    const card = folderCard(
      "drop.example.org",
      "golf-sim/sfx/",
      [entry("golf-sim/sfx/1.wav")],
      [],
      [{ key: "golf-sim/sfx/1.wav", size: 3 }]
    );
    expect(flatten(card)).toContain("drop.example.org");
  });

  test("the same folder on a preview host cards the preview host", () => {
    const card = folderCard("preview-cdn.workers.dev", "golf-sim/sfx/", [], [], []);
    const json = flatten(card);
    expect(json).toContain("preview-cdn.workers.dev");
    expect(json).toContain("Empty folder.");
  });
});
