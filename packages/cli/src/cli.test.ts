// The CLI, driven the way an agent drives it: real argv in, a real envelope out.
//
// `cli.serve(argv, { stdout, exit, env })` is incur's own test seam, so these run
// the actual command tree — parsing, schemas, envelope, CTAs — without spawning a
// process. The one thing it cannot exercise is the shebang, so a couple of tests
// spawn `bin/cdn.ts` to prove the executable itself boots.
//
// Hermetic: a Bun.serve stub stands in for the Worker, reached over loopback
// because `originFor` speaks http there, and XDG_CONFIG_HOME points at a temp
// dir so no real host file is ever visible.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import cli from "./cli.ts";
import { keyForFile, keyInDir, prefixForDir, walk } from "./keys.ts";

type Received = { key: string; auth: string | null; body: string; permanent: boolean };

type Stub = {
  stop: () => void;
  host: string;
  received: Received[];
  /** What `GET /api/auth` answers — the contract handshake under test. */
  contract: number;
  status: number;
};

const startStub = (): Stub => {
  const received: Received[] = [];
  const state = { contract: 1, status: 200 };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const authed = req.headers.get("authorization") === "Bearer good-token";
      if (url.pathname === "/api/auth") {
        if (!authed) return new Response("unauthorized", { status: 401 });
        return Response.json({ contract: state.contract });
      }
      if (url.pathname !== "/api/upload") return new Response("nope", { status: 404 });
      if (!authed) return new Response("unauthorized", { status: 401 });
      const key = url.searchParams.get("key") ?? "";
      received.push({
        key,
        auth: req.headers.get("authorization"),
        body: await req.text(),
        permanent: url.searchParams.get("permanent") === "1",
      });
      if (state.status >= 400) return new Response("boom", { status: state.status });
      const path = key
        .split("/")
        .map((s) => encodeURIComponent(s))
        .join("/");
      return Response.json({ ok: true, key, url: `http://${url.host}/${path}`, permanent: false });
    },
  });
  return {
    stop: () => server.stop(true),
    host: `localhost:${server.port}`,
    received,
    get contract() {
      return state.contract;
    },
    set contract(v: number) {
      state.contract = v;
    },
    get status() {
      return state.status;
    },
    set status(v: number) {
      state.status = v;
    },
  };
};

let dir = "";
let hosts = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdn-cli-"));
  hosts = join(dir, "config", "cdn", "hosts");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Ran = { code: number; out: string; json: Record<string, unknown> };

/** Run a command and parse its JSON envelope. `--full-output` so the assertions
    can see `ok`, `data` and `error` rather than only the happy-path payload. */
const run = async (argv: string[], env: Record<string, string> = {}): Promise<Ran> => {
  let out = "";
  let code = 0;
  // The env passed here is the ONLY environment the commands see — XDG_CONFIG_HOME
  // and HOME are declared inputs precisely so this seam is total. Without that,
  // an `auth login` test writes a token into the real ~/.config, which is how
  // this harness was first written and what it did.
  await cli.serve([...argv, "--json", "--full-output"], {
    stdout(s) {
      out += s;
    },
    exit(c) {
      code = c;
    },
    env: { XDG_CONFIG_HOME: join(dir, "config"), HOME: dir, ...env },
  });
  let json: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed === "object" && parsed !== null) json = { ...parsed };
  } catch {
    json = {};
  }
  return { code, out, json };
};

const dataOf = (r: Ran) => (r.json.data ?? {}) as Record<string, unknown>;
const errorOf = (r: Ran) => (r.json.error ?? {}) as Record<string, unknown>;

const writeHost = (host: string, token = "good-token") =>
  Bun.write(join(hosts, `${host}.env`), `CDN_TOKEN=${token}\n`);

// ── the key rules, which predate the CLI and are the reason it exists ────────
describe("key rules", () => {
  const slug = () => "a1b2c3";

  test("a lone file gets a random slug and keeps its real extension", () => {
    // The extension is load-bearing: the Worker types the object from it, so a
    // key without one downloads instead of rendering.
    expect(keyForFile("/tmp/shot.png", undefined, slug)).toBe("a1b2c3.png");
    expect(keyForFile("/tmp/LICENSE", undefined, slug)).toBe("a1b2c3");
  });

  test("a trailing slash is a namespace, anything else is the exact key", () => {
    expect(keyForFile("/tmp/shot.png", "notes/", slug)).toBe("notes/a1b2c3.png");
    expect(keyForFile("/tmp/shot.png", "notes/hero.png", slug)).toBe("notes/hero.png");
  });

  test("a destination with no extension borrows the source's", () => {
    expect(keyForFile("/tmp/shot.png", "notes/hero", slug)).toBe("notes/hero.png");
  });

  test("a leading slash never survives — keys are relative to the bucket root", () => {
    expect(keyForFile("/tmp/shot.png", "/notes/hero.png", slug)).toBe("notes/hero.png");
  });

  test("a directory becomes a prefix, named for itself unless told otherwise", () => {
    expect(prefixForDir("./shots")).toBe("shots/");
    expect(prefixForDir("./shots/")).toBe("shots/");
    expect(prefixForDir("./shots", "notes/")).toBe("notes/");
    // Always ends in a slash: a prefix that doesn't is a file key, and the folder
    // page is the whole reason to upload a directory.
    expect(prefixForDir("./shots", "notes")).toBe("notes/");
  });

  test("files inside a directory keep their relative path", () => {
    expect(keyInDir("shots/", "./shots", "shots/deep/a.png")).toBe("shots/deep/a.png");
  });

  test("walk skips .DS_Store and .git, and is stably ordered", async () => {
    await Bun.write(join(dir, "t", "b.txt"), "b");
    await Bun.write(join(dir, "t", "a.txt"), "a");
    await Bun.write(join(dir, "t", ".DS_Store"), "junk");
    await Bun.write(join(dir, "t", ".git", "config"), "junk");
    await Bun.write(join(dir, "t", "deep", "c.txt"), "c");
    expect((await walk(join(dir, "t"))).map((f) => f.slice(dir.length + 3))).toEqual([
      "a.txt",
      "b.txt",
      "deep/c.txt",
    ]);
  });
});

describe("cdn up", () => {
  test("uploads one file and returns what the Worker minted", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      const src = join(dir, "shot.png");
      await Bun.write(src, "png-bytes");

      const r = await run(["up", src]);
      expect(r.json.ok).toBe(true);
      expect(stub.received).toHaveLength(1);
      expect(stub.received[0]?.auth).toBe("Bearer good-token");
      expect(stub.received[0]?.key).toMatch(/^[0-9a-f]{6}\.png$/);

      const data = dataOf(r);
      expect(data.url).toBe(`http://${stub.host}/${stub.received[0]?.key}`);
      expect(data.files).toBe(1);
      expect(data.bytes).toBe(9);
      expect(data.permanent).toBe(false);
    } finally {
      stub.stop();
    }
  });

  test("--dest and --permanent are honoured", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      const src = join(dir, "app.zip");
      await Bun.write(src, "zip");
      const r = await run(["up", src, "releases/app.zip", "--permanent"]);
      expect(r.json.ok).toBe(true);
      expect(stub.received[0]?.key).toBe("releases/app.zip");
      expect(stub.received[0]?.permanent).toBe(true);
    } finally {
      stub.stop();
    }
  });

  test("a directory uploads every file and answers with the folder page", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "shots", "a.png"), "aa");
      await Bun.write(join(dir, "shots", "deep", "b.png"), "bbb");

      const r = await run(["up", join(dir, "shots")]);
      expect(r.json.ok).toBe(true);
      expect(stub.received.map((x) => x.key).sort()).toEqual(["shots/a.png", "shots/deep/b.png"]);

      const data = dataOf(r);
      // The folder URL is derived from a URL the Worker returned, never composed
      // from a domain string.
      expect(data.url).toBe(`http://${stub.host}/shots/`);
      expect(data.key).toBe("shots/");
      expect(data.files).toBe(2);
      expect(data.bytes).toBe(5);
    } finally {
      stub.stop();
    }
  });

  test("an auth failure answers with the exact command that fixes it", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host, "wrong-token");
      const src = join(dir, "a.txt");
      await Bun.write(src, "a");

      const r = await run(["up", src]);
      expect(r.json.ok).toBe(false);
      expect(r.code).not.toBe(0);
      const err = errorOf(r);
      expect(err.code).toBe("UPLOAD_FAILED");
      expect(String(err.message)).toContain("401");
      // The CTA is the point of the CLI over curl: an agent reading this knows
      // its next move without being told separately.
      expect(JSON.stringify(r.json.meta)).toContain("cdn auth login");
    } finally {
      stub.stop();
    }
  });

  test("no configured host is a typed error naming the path to create", async () => {
    const src = join(dir, "a.txt");
    await Bun.write(src, "a");
    const r = await run(["up", src]);
    expect(r.json.ok).toBe(false);
    const err = errorOf(r);
    expect(err.code).toBe("NOT_AUTHENTICATED");
    expect(String(err.message)).toContain(hosts);
    expect(JSON.stringify(r.json.meta)).toContain("cdn auth login");
  });

  test("a missing file fails before any request", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      const r = await run(["up", join(dir, "gone.txt")]);
      expect(errorOf(r).code).toBe("NOT_FOUND");
      expect(stub.received).toHaveLength(0);
    } finally {
      stub.stop();
    }
  });

  test("an empty directory is an error, not an empty folder link", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "empty", ".DS_Store"), "junk");
      const r = await run(["up", join(dir, "empty")]);
      expect(errorOf(r).code).toBe("EMPTY_DIRECTORY");
      expect(stub.received).toHaveLength(0);
    } finally {
      stub.stop();
    }
  });

  // Precedence is flags > env > file, and --host is the flag half.
  test("--host beats the configured default", async () => {
    const stub = startStub();
    try {
      await writeHost("cdn.example.com", "other-token");
      await writeHost(stub.host);
      const src = join(dir, "a.txt");
      await Bun.write(src, "a");

      // Two hosts configured, so without --host this would refuse to guess.
      const refused = await run(["up", src]);
      expect(refused.json.ok).toBe(false);

      const r = await run(["up", src, "--host", stub.host]);
      expect(r.json.ok).toBe(true);
      expect(stub.received[0]?.auth).toBe("Bearer good-token");
    } finally {
      stub.stop();
    }
  });
});

describe("cdn auth login", () => {
  test("verifies the token, then writes it 0600", async () => {
    const stub = startStub();
    try {
      const r = await run(["auth", "login", "--host", stub.host, "--token", "good-token"]);
      expect(r.json.ok).toBe(true);

      const data = dataOf(r);
      const file = join(hosts, `${stub.host}.env`);
      expect(data.file).toBe(file);
      expect(data.mode).toBe("0600");
      expect(data.contract).toBe(1);
      expect(((await stat(file)).mode & 0o777).toString(8)).toBe("600");
      expect(await Bun.file(file).text()).toBe("CDN_TOKEN=good-token\n");
    } finally {
      stub.stop();
    }
  });

  // A token file that doesn't work is worse than none: it turns "you are not
  // logged in" into "uploads mysteriously fail".
  test("a rejected token is never written to disk", async () => {
    const stub = startStub();
    try {
      const r = await run(["auth", "login", "--host", stub.host, "--token", "wrong"]);
      expect(r.json.ok).toBe(false);
      expect(errorOf(r).code).toBe("VERIFICATION_FAILED");
      expect(await Bun.file(join(hosts, `${stub.host}.env`)).exists()).toBe(false);
    } finally {
      stub.stop();
    }
  });

  // The two sides are allowed to be different ages; a version this client does
  // not know has to fail at the handshake, naming both numbers.
  test("an unknown contract fails legibly and writes nothing", async () => {
    const stub = startStub();
    try {
      stub.contract = 99;
      const r = await run(["auth", "login", "--host", stub.host, "--token", "good-token"]);
      expect(r.json.ok).toBe(false);
      const message = String(errorOf(r).message);
      expect(message).toContain("99");
      expect(message).toContain("1");
      expect(await Bun.file(join(hosts, `${stub.host}.env`)).exists()).toBe(false);
    } finally {
      stub.stop();
    }
  });

  test("refuses to prompt when there is no terminal to ask", async () => {
    const stub = startStub();
    try {
      const r = await run(["auth", "login", "--host", stub.host]);
      expect(r.json.ok).toBe(false);
      expect(errorOf(r).code).toBe("TOKEN_REQUIRED");
    } finally {
      stub.stop();
    }
  });

  test("a host that is not a filename is refused before anything is written", async () => {
    const stub = startStub();
    try {
      const r = await run([
        "auth",
        "login",
        "--host",
        "../escape",
        "--token",
        "good-token",
        "--host",
        "../escape",
      ]);
      expect(r.json.ok).toBe(false);
    } finally {
      stub.stop();
    }
  });
});

describe("cdn auth status", () => {
  test("explains which host wins and why, per precedence step", async () => {
    await writeHost("cdn.example.com");
    const sole = await run(["auth", "status"]);
    expect(String(dataOf(sole).why)).toContain("only host file");
    expect(dataOf(sole).active).toBe("cdn.example.com");

    await writeHost("files.work.example");
    const ambiguous = await run(["auth", "status"]);
    // Two files and no CDN_HOST: no active host, and the reason says so.
    expect(dataOf(ambiguous).active).toBeUndefined();
    expect(String(dataOf(ambiguous).why)).toContain("CDN_HOST");

    const named = await run(["auth", "status"], { CDN_HOST: "files.work.example" });
    expect(dataOf(named).active).toBe("files.work.example");
    expect(String(dataOf(named).why)).toContain("CDN_HOST names");

    const flagged = await run(["auth", "status", "--host", "cdn.example.com"]);
    expect(dataOf(flagged).active).toBe("cdn.example.com");
    expect(String(dataOf(flagged).why)).toContain("--host");
  });

  test("says when the token came from the environment rather than the file", async () => {
    await writeHost("cdn.example.com");
    const r = await run(["auth", "status"], { CDN_TOKEN: "from-env" });
    expect(String(dataOf(r).why)).toContain("overridden by CDN_TOKEN");
  });

  test("lists every host with its mode, and warns about one others can read", async () => {
    await writeHost("cdn.example.com");
    await chmod(join(hosts, "cdn.example.com.env"), 0o644);
    const r = await run(["auth", "status"]);

    const list = dataOf(r).hosts as Array<Record<string, unknown>>;
    expect(list).toHaveLength(1);
    expect(list[0]?.mode).toBe("0644");
    expect(list[0]?.secure).toBe(false);
    // A warning here and a refusal in `login`: status's job is to tell you the
    // truth about what is on disk, not to withhold it.
    expect(r.json.ok).toBe(true);
    expect(JSON.stringify(r.json)).toContain("rotate");
  });
});

// The seam above skips the shebang and the argv wiring, which is exactly where a
// CLI breaks for the person who installed it rather than for its own tests.
describe("the executable", () => {
  const BIN = join(import.meta.dir, "..", "bin", "cdn.ts");

  test("boots, reports its version, and describes itself to an agent", async () => {
    const version = Bun.spawnSync([BIN, "--version"]);
    expect(version.exitCode).toBe(0);
    expect(version.stdout.toString().trim()).toBe("0.1.0");

    const llms = Bun.spawnSync([BIN, "--llms"]);
    expect(llms.exitCode).toBe(0);
    const manifest = llms.stdout.toString();
    expect(manifest).toContain("cdn up");
    expect(manifest).toContain("cdn auth login");

    // The full manifest is what `skills add` and the committed SKILL.md carry, so
    // it is the one that has to explain the verbs that DON'T exist — otherwise an
    // agent reaches for `cdn ls`, gets nothing useful, and invents a workaround.
    const full = Bun.spawnSync([BIN, "--llms-full"]);
    expect(full.exitCode).toBe(0);
    expect(full.stdout.toString()).toContain("No `ls` or `rm`");
  });
});
