// The local half of setup: reading the tree, and editing wrangler.jsonc without
// destroying it.
//
// The config is mostly comments — every non-obvious decision in this project is
// explained inside it — so these tests are as much about what survives an edit as
// about what changes. A `JSON.parse` round-trip would pass a "does it have a
// route" test and silently delete the reason for every other line in the file.

import { describe, expect, test } from "bun:test";

import {
  accountIdFrom,
  addPurgeVars,
  addRoute,
  hasRoute,
  hasVar,
  recordingRunner,
  routePatterns,
  workerName,
  zoneCandidates,
} from "./wrangler.ts";

// The shape the template actually ships: a commented-out example of the very
// thing setup is about to add, which is exactly the trap a naive check falls in.
const TEMPLATE = `{
  "$schema": "node_modules/wrangler/config-schema.json",
  "name": "cdn-explorer",
  "main": "src/worker.ts",
  "compatibility_date": "2026-06-01",
  "observability": { "enabled": true },

  // No \`routes\` here: this repo is a template, and the zone belongs to whoever
  // presses the button.
  //
  //   "routes": [{ "pattern": "cdn.example.com", "custom_domain": true }],
  //
  // Nothing else changes.
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "cdn" }],
  "preview_urls": true
}
`;

describe("reading the config", () => {
  test("a commented-out example is not a route", () => {
    // The whole point: the template documents the line it does not have.
    expect(hasRoute(TEMPLATE)).toBe(false);
    expect(routePatterns(TEMPLATE)).toEqual([]);
  });

  test("a real route is found, with its patterns", () => {
    const configured = `{
  "compatibility_date": "2026-06-01",
  "routes": [{ "pattern": "cdn.example.com", "custom_domain": true }],
}`;
    expect(hasRoute(configured)).toBe(true);
    expect(routePatterns(configured)).toEqual(["cdn.example.com"]);
  });

  test("the worker name comes from the tree, so setup never asks for it", () => {
    expect(workerName(TEMPLATE)).toBe("cdn-explorer");
  });

  test("a commented-out var is not a var", () => {
    expect(hasVar(TEMPLATE, "CDN_ZONE_ID")).toBe(false);
    expect(hasVar(`{"vars":{"CDN_ZONE_ID":"abc"}}`, "CDN_ZONE_ID")).toBe(true);
  });
});

describe("addRoute", () => {
  test("inserts one route and keeps every comment", () => {
    const result = addRoute(TEMPLATE, "cdn.example.com");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(hasRoute(result.config)).toBe(true);
    expect(routePatterns(result.config)).toEqual(["cdn.example.com"]);
    // Nothing else moved: the comments that explain the file are still there.
    expect(result.config).toContain("this repo is a template");
    expect(result.config).toContain('"r2_buckets"');
    expect(result.config).toContain('"preview_urls": true');
  });

  test("refuses rather than adding a second one", () => {
    const once = addRoute(TEMPLATE, "cdn.example.com");
    if (!once.ok) throw new Error("setup failed");
    const twice = addRoute(once.config, "other.example.com");
    expect(twice.ok).toBe(false);
    if (twice.ok) return;
    expect(twice.error).toContain("already declares routes");
  });

  test("says so when there is no anchor to insert after", () => {
    const result = addRoute(`{ "name": "x" }`, "cdn.example.com");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("compatibility_date");
  });
});

describe("addPurgeVars", () => {
  test("adds both, with the reason they are not secrets", () => {
    const result = addPurgeVars(TEMPLATE, "zone123", "https://cdn.example.com");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(hasVar(result.config, "CDN_ZONE_ID")).toBe(true);
    expect(hasVar(result.config, "CDN_PUBLIC_ORIGIN")).toBe(true);
    expect(result.config).toContain("zone123");
    expect(result.config).toContain("https://cdn.example.com");
    expect(result.config).toContain('"r2_buckets"'); // still intact
  });

  // Merging into a `vars` block someone else wrote means guessing at their
  // formatting. Saying so is better than reformatting a file that isn't ours.
  test("refuses to merge into an existing vars block", () => {
    const withVars = `{
  "compatibility_date": "2026-06-01",
  "vars": { "SOMETHING_ELSE": "x" }
}`;
    const result = addPurgeVars(withVars, "z", "https://x");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("by hand");
  });
});

describe("accountIdFrom", () => {
  test("finds the id in whatever table wrangler printed", () => {
    const whoami = `
 ⛅️ wrangler 4.97.0
 Getting User settings...
 👋 You are logged in with an OAuth Token, associated with the email someone@example.com.
 ┌──────────────────────┬──────────────────────────────────┐
 │ Account Name         │ Account ID                       │
 ├──────────────────────┼──────────────────────────────────┤
 │ Someone's Account    │ a1b2c3d4e5f60718293a4b5c6d7e8f90 │
 └──────────────────────┴──────────────────────────────────┘`;
    expect(accountIdFrom(whoami)).toBe("a1b2c3d4e5f60718293a4b5c6d7e8f90");
  });

  test("undefined rather than a wrong guess when there is no id", () => {
    expect(accountIdFrom("not logged in")).toBeUndefined();
  });
});

describe("zoneCandidates", () => {
  // "Strip to the last two labels" is wrong for every multi-part public suffix,
  // and getting it right in general needs a public-suffix list — a dependency
  // that goes stale. Asking the API which of these exists is exact instead.
  test("offers each suffix, most specific first, so .co.uk works without a suffix list", () => {
    // Most specific first because a subdomain can be a zone in its own right,
    // and if it is, that is the zone whose settings and purges apply here.
    expect(zoneCandidates("cdn.example.co.uk")).toEqual([
      "cdn.example.co.uk",
      "example.co.uk",
      "co.uk",
    ]);
    expect(zoneCandidates("cdn.example.com")).toEqual(["cdn.example.com", "example.com"]);
  });

  test("an apex domain is its own candidate, and a bare label has none", () => {
    expect(zoneCandidates("example.com")).toEqual(["example.com"]);
    expect(zoneCandidates("localhost")).toEqual([]);
  });
});

describe("recordingRunner", () => {
  // The dry-run seam: the same code path, and what gets printed is literally the
  // list of things that would have run.
  test("records commands and answers success without running them", async () => {
    const log: { argv: string[]; input?: string }[] = [];
    const run = recordingRunner(log);
    expect(await run({ argv: ["wrangler", "deploy"] })).toEqual({
      code: 0,
      stdout: "",
      stderr: "",
    });
    await run({ argv: ["wrangler", "secret", "put", "CDN_PURGE_TOKEN"], input: "s3cret" });
    expect(log).toEqual([
      { argv: ["wrangler", "deploy"] },
      { argv: ["wrangler", "secret", "put", "CDN_PURGE_TOKEN"], input: "s3cret" },
    ]);
  });
});
