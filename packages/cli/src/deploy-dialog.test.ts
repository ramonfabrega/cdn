// The deploy dialog is a file, so it can be tested like one.
//
// `.dev.vars.example` IS the Deploy to Cloudflare setup form: the button builds
// the dialog from it. That makes it the single most consequential file in this
// repo for anyone who is not us — the first thing a stranger sees, and the last
// place a mistake is cheap. It has been wrong twice in one day, both times in a
// way no test would have caught because nothing tested it.
//
// What was measured on a real press (2026-09-07), none of which the docs state:
//
//   1. Every UNCOMMENTED key becomes a field.
//   2. Every field is REQUIRED — the browser refuses an empty one. There is no
//      way to mark a secret optional, so a key listed here is a box a stranger
//      MUST type something into, and whatever they type becomes a real
//      credential on a real Worker.
//   3. The VALUE becomes the field's prefilled default. This file once shipped
//      `change-me`, which meant a session cookie signed with a string printed in
//      a public repository — forgeable by anyone who read it.
//   4. package.json `cloudflare.bindings` descriptions DO NOT RENDER for
//      secrets. Guidance written there is invisible at the moment it is needed.
//
// Together those give one rule, and this file enforces it: a key belongs in
// `.dev.vars.example` only if a first deploy cannot work without it. Exactly one
// does.

import { describe, expect, test } from "bun:test";

import { parseDotenv } from "./hosts.ts";

const EXAMPLE = new URL("../../../.dev.vars.example", import.meta.url).pathname;

describe(".dev.vars.example — the deploy dialog", () => {
  test("prompts for exactly one secret, and it is the one that is required", async () => {
    const parsed = parseDotenv(await Bun.file(EXAMPLE).text());
    // Every key here is a required field in a stranger's deploy dialog. Adding
    // one is a product decision, not a documentation change — which is what this
    // assertion is here to make you notice.
    expect(Object.keys(parsed)).toEqual(["CDN_PASSWORD"]);
  });

  test("ships no value, because a value here is a default there", async () => {
    const parsed = parseDotenv(await Bun.file(EXAMPLE).text());
    expect(parsed.CDN_PASSWORD).toBe("");
  });

  test("still documents the optional three, as comments rather than as fields", async () => {
    const text = await Bun.file(EXAMPLE).text();
    const parsed = parseDotenv(text);
    for (const name of ["CDN_UPLOAD_TOKEN", "CDN_SESSION_SECRET", "CDN_PURGE_TOKEN"]) {
      // Mentioned — someone reaching for it must find out what it does…
      expect(text).toContain(name);
      // …but commented out, so the button never asks a stranger to invent one.
      expect(parsed[name]).toBeUndefined();
    }
  });

  test("every secret the Worker reads is accounted for, one way or the other", async () => {
    const text = await Bun.file(EXAMPLE).text();
    const worker = await Bun.file(
      new URL("../../../src/worker.ts", import.meta.url).pathname
    ).text();
    const used = [...worker.matchAll(/env\.(CDN_[A-Z_]+)/g)].map((m) => m[1] ?? "");
    for (const name of new Set(used)) {
      expect(text).toContain(name);
    }
  });
});
