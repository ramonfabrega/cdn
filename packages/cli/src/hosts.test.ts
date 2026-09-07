// Runs in Bun (`bun test client/`), not workerd — these read the real filesystem,
// in a temp dir per test, and never touch the caller's ~/.config.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hostsDir, listHosts, parseDotenv, resolveTarget } from "./hosts.ts";

let root = "";
let dir = "";

// XDG_CONFIG_HOME is the seam: point it at a temp dir and the reader looks
// exactly where a real one would, one level down.
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cdn-hosts-"));
  dir = join(root, "cdn", "hosts");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const env = (extra: Record<string, string | undefined> = {}) => ({
  XDG_CONFIG_HOME: root,
  ...extra,
});

const writeHost = (host: string, body: string) => Bun.write(join(dir, `${host}.env`), body);

describe("hostsDir", () => {
  test("honours XDG_CONFIG_HOME, falling back to ~/.config", () => {
    expect(hostsDir({ XDG_CONFIG_HOME: "/xdg" })).toBe("/xdg/cdn/hosts");
    expect(hostsDir({ HOME: "/home/someone" })).toBe("/home/someone/.config/cdn/hosts");
  });
});

describe("parseDotenv", () => {
  test("reads the subset the three readers agree on", () => {
    const parsed = parseDotenv(
      [
        "# a comment",
        "",
        "CDN_TOKEN=plain",
        'QUOTED="in quotes"',
        "SINGLE='also quotes'",
        "TRAILING=value # not part of it",
        "export EXPORTED=sourceable",
        "  SPACED = padded ",
        "not an assignment",
      ].join("\n")
    );
    expect(parsed).toEqual({
      CDN_TOKEN: "plain",
      QUOTED: "in quotes",
      SINGLE: "also quotes",
      TRAILING: "value",
      EXPORTED: "sourceable",
      SPACED: "padded",
    });
  });

  test("a `#` inside a quoted value is part of the token, not a comment", () => {
    expect(parseDotenv('CDN_TOKEN="ab#cd"').CDN_TOKEN).toBe("ab#cd");
  });
});

describe("listHosts", () => {
  test("names every host file and whether anyone else can read it", async () => {
    await writeHost("cdn.example.com", "CDN_TOKEN=a\n");
    await writeHost("files.work.example", "CDN_TOKEN=b\n");
    await chmod(join(dir, "cdn.example.com.env"), 0o600);
    await chmod(join(dir, "files.work.example.env"), 0o644);

    const hosts = await listHosts(env());
    expect(hosts.map((h) => h.host)).toEqual(["cdn.example.com", "files.work.example"]);
    // A token the group or the world can read is a token to rotate; the owner
    // bits are the owner's business.
    expect(hosts[0]?.secure).toBe(true);
    expect(hosts[1]?.secure).toBe(false);
    expect(hosts[1]?.mode).toBe(0o644);
  });

  test("no directory is an empty list, not a throw", async () => {
    expect(await listHosts({ XDG_CONFIG_HOME: join(root, "nope") })).toEqual([]);
  });
});

describe("resolveTarget", () => {
  test("the sole host file is the default — nothing to configure", async () => {
    await writeHost("cdn.example.com", "CDN_TOKEN=from-file\n");
    expect(await resolveTarget(env())).toEqual({
      ok: true,
      target: {
        host: "cdn.example.com",
        token: "from-file",
        source: "default",
        tokenFrom: "file",
        file: join(dir, "cdn.example.com.env"),
      },
    });
  });

  test("CDN_HOST names which file when there are several", async () => {
    await writeHost("cdn.example.com", "CDN_TOKEN=personal\n");
    await writeHost("files.work.example", "CDN_TOKEN=work\n");
    expect(await resolveTarget(env({ CDN_HOST: "files.work.example" }))).toEqual({
      ok: true,
      target: {
        host: "files.work.example",
        token: "work",
        source: "CDN_HOST",
        tokenFrom: "file",
        file: join(dir, "files.work.example.env"),
      },
    });
  });

  // Guessing between two configured hosts would mirror a file to the wrong
  // organization — a failure you'd hear about from the recipient.
  test("two hosts and no CDN_HOST is an error that lists them", async () => {
    await writeHost("cdn.example.com", "CDN_TOKEN=personal\n");
    await writeHost("files.work.example", "CDN_TOKEN=work\n");
    const res = await resolveTarget(env());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("cdn.example.com");
    expect(res.error).toContain("files.work.example");
    expect(res.error).toContain("CDN_HOST");
  });

  test("both env vars win outright — no file has to exist", async () => {
    expect(
      await resolveTarget(env({ CDN_HOST: "nowhere.example", CDN_TOKEN: "from-env" }))
    ).toEqual({
      ok: true,
      target: { host: "nowhere.example", token: "from-env", source: "env", tokenFrom: "env" },
    });
  });

  // The precedence step is part of the answer, not trivia: `cdn auth status` has
  // to be able to explain which one decided, and "the token came from somewhere
  // other than the file you're looking at" is exactly the confusing case.
  test("CDN_TOKEN alone overrides the file's token, keeping its host", async () => {
    await writeHost("cdn.example.com", "CDN_TOKEN=from-file\n");
    expect(await resolveTarget(env({ CDN_TOKEN: "from-env" }))).toEqual({
      ok: true,
      target: {
        host: "cdn.example.com",
        token: "from-env",
        source: "default",
        tokenFrom: "env",
        file: join(dir, "cdn.example.com.env"),
      },
    });
  });

  // Every failure names the path to create; an error that only says "not
  // configured" leaves you guessing at a directory nobody has ever seen.
  test("no hosts directory at all names the file to create", async () => {
    const res = await resolveTarget(env());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(join(dir, "<host>.env"));
    expect(res.error).toContain("CDN_TOKEN");
  });

  test("an empty hosts directory names the directory", async () => {
    await Bun.write(join(dir, "README"), "not a host file\n");
    const res = await resolveTarget(env());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(dir);
  });

  test("CDN_HOST pointing at a file that isn't there names that file", async () => {
    await writeHost("cdn.example.com", "CDN_TOKEN=personal\n");
    const res = await resolveTarget(env({ CDN_HOST: "typo.example.com" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain(join(dir, "typo.example.com.env"));
  });

  test("a host file with no CDN_TOKEN line says so", async () => {
    await writeHost("cdn.example.com", "# nothing useful here\nOTHER=x\n");
    const res = await resolveTarget(env());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toContain("CDN_TOKEN");
  });
});
