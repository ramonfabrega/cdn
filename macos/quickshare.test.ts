// Tests for macos/quickshare, run in Bun (`bun test macos/`) against the same
// Bun.serve stub pattern the hooks use.
//
// What is testable here is everything up to the GUI: which arguments become which
// keys, how a multi-selection becomes one folder, that the printed URL is the
// SERVER's and not one composed locally, and every refusal. The interactive
// capture path is not testable and does not pretend to be — `screencapture -i`
// blocks on a human dragging a crosshair, so the only thing asserted about it is
// the guard that stops an agent from reaching it.
//
// `screencapture`, `pbcopy` and `osascript` are replaced by fakes on PATH; the
// script appends the system directories to PATH rather than replacing it, which
// is what makes that possible (and what keeps a bare GUI environment working).

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Received = { key: string; auth: string | null; body: string; permanent: boolean };
type Stub = { stop: () => void; host: string; received: Received[] };

const startStub = ({ status = 200 }: { status?: number } = {}): Stub => {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/upload") return new Response("no such route", { status: 404 });
      const key = url.searchParams.get("key") ?? "";
      received.push({
        key,
        auth: req.headers.get("authorization"),
        body: await req.text(),
        permanent: url.searchParams.get("permanent") === "1",
      });
      if (status >= 400) return new Response("nope", { status });
      // The Worker's own shape: it mints the url from the request it answered, and
      // every client is supposed to print that rather than build one.
      const path = key
        .split("/")
        .map((s) => encodeURIComponent(s))
        .join("/");
      return Response.json({ ok: true, key, url: `http://${url.host}/${path}`, permanent: false });
    },
  });
  return { stop: () => server.stop(true), host: `localhost:${server.port}`, received };
};

const SCRIPT = join(import.meta.dir, "quickshare");

let dir = "";
let bin = "";
let hosts = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "quickshare-"));
  bin = join(dir, "fakebin");
  hosts = join(dir, "config", "cdn", "hosts");
  await mkdir(bin, { recursive: true });
  await mkdir(hosts, { recursive: true });

  // Fakes for the three GUI tools. pbcopy records what would have been copied;
  // osascript swallows the notification; screencapture writes nothing, standing in
  // for a cancelled pick.
  const fake = async (name: string, body: string) => {
    const p = join(bin, name);
    await Bun.write(p, `#!/bin/bash\n${body}\n`);
    await chmod(p, 0o755);
  };
  await fake("pbcopy", `cat > "${join(dir, "clipboard")}"`);
  await fake("osascript", `printf '%s\\n' "$*" >> "${join(dir, "notifications")}"`);
  await fake("screencapture", ":");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const writeHost = (host: string, token = "t0ken") =>
  Bun.write(join(hosts, `${host}.env`), `CDN_TOKEN=${token}\n`);

type Run = { code: number; out: string; err: string; clipboard: string };

const run = async (args: string[], env: Record<string, string> = {}): Promise<Run> => {
  const proc = Bun.spawn([SCRIPT, ...args], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
    // The fakes go FIRST so they shadow the real tools; XDG points at the temp
    // config so no real host file is ever visible.
    env: {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      HOME: dir,
      TMPDIR: dir,
      XDG_CONFIG_HOME: join(dir, "config"),
      ...env,
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const clipboard = await Bun.file(join(dir, "clipboard"))
    .text()
    .catch(() => "");
  return { code, out: out.trim(), err: err.trim(), clipboard };
};

describe("one file", () => {
  test("uploads with the bearer and prints the url the SERVER returned", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "shot.png"), "png-bytes");
      const res = await run(["shot.png"]);

      expect(res.code).toBe(0);
      expect(stub.received).toHaveLength(1);
      expect(stub.received[0]?.auth).toBe("Bearer t0ken");
      expect(stub.received[0]?.body).toBe("png-bytes");
      // A random 6-hex slug carrying the real extension — the local filename never
      // reaches a public URL, and the Worker types the object from the key.
      expect(stub.received[0]?.key).toMatch(/^[0-9a-f]{6}\.png$/);

      expect(res.out).toBe(`http://${stub.host}/${stub.received[0]?.key}`);
      // Bare url, no trailing newline: pasting into Slack or a browser bar must not
      // submit early or leave a dangling blank line.
      expect(res.clipboard).toBe(res.out);
      expect(res.clipboard).not.toEndWith("\n");
    } finally {
      stub.stop();
    }
  });

  test("a file with no extension still uploads", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "LICENSE"), "MIT");
      const res = await run(["LICENSE"]);
      expect(res.code).toBe(0);
      expect(stub.received[0]?.key).toMatch(/^[0-9a-f]{6}$/);
    } finally {
      stub.stop();
    }
  });

  test("--permanent rides along on the query", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "app.zip"), "zip");
      const res = await run(["app.zip", "--permanent"]);
      expect(res.code).toBe(0);
      expect(stub.received[0]?.permanent).toBe(true);
    } finally {
      stub.stop();
    }
  });

  // Flags are this script's own now, so a typo is an error rather than something
  // silently dropped.
  test("an unknown flag is refused", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "a.txt"), "a");
      const res = await run(["a.txt", "--permanant"]);
      expect(res.code).toBe(1);
      expect(res.err).toContain("unknown option: --permanant");
      expect(stub.received).toHaveLength(0);
    } finally {
      stub.stop();
    }
  });
});

describe("several files", () => {
  // Exactly one URL, always: a clipboard holding several is a trap, because any
  // single-line paste target eats the separator and welds them into one dead string.
  test("become one folder, keeping their real names inside it", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "anim.mov"), "mov");
      await Bun.write(join(dir, "notes.txt"), "txt");
      const res = await run(["anim.mov", "notes.txt"]);

      expect(res.code).toBe(0);
      expect(stub.received).toHaveLength(2);
      const keys = stub.received.map((r) => r.key).sort();
      const prefix = keys[0]?.split("/")[0] ?? "";
      expect(prefix).toMatch(/^[0-9a-f]{6}$/);
      expect(keys).toEqual([`${prefix}/anim.mov`, `${prefix}/notes.txt`]);

      // One link that shows the whole set — the Worker already serves any prefix
      // as a public listing page.
      expect(res.out).toBe(`http://${stub.host}/${prefix}/`);
      expect(res.clipboard).toBe(res.out);
    } finally {
      stub.stop();
    }
  });

  test("a directory in the selection keeps its own name as a subfolder", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "top.txt"), "top");
      await Bun.write(join(dir, "shots", "a.png"), "a");
      await Bun.write(join(dir, "shots", "deep", "b.png"), "b");
      const res = await run(["top.txt", "shots"]);

      expect(res.code).toBe(0);
      const keys = stub.received.map((r) => r.key).sort();
      const prefix = keys[0]?.split("/")[0] ?? "";
      expect(keys).toEqual([
        `${prefix}/shots/a.png`,
        `${prefix}/shots/deep/b.png`,
        `${prefix}/top.txt`,
      ]);
      expect(res.out).toBe(`http://${stub.host}/${prefix}/`);
    } finally {
      stub.stop();
    }
  });

  test("a filename with a space survives the trip percent-encoded", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "Screen Shot.png"), "one");
      await Bun.write(join(dir, "other.png"), "two");
      const res = await run(["Screen Shot.png", "other.png"]);
      expect(res.code).toBe(0);
      // The stub reads the DECODED key, so arriving intact proves the encoding.
      expect(stub.received.map((r) => r.key).sort()).toContainEqual(
        expect.stringContaining("/Screen Shot.png")
      );
    } finally {
      stub.stop();
    }
  });
});

describe("a single directory", () => {
  test("keeps its own name rather than getting a random prefix", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "shots", "a.png"), "a");
      await Bun.write(join(dir, "shots", "b.png"), "b");
      const res = await run(["shots"]);

      expect(res.code).toBe(0);
      expect(stub.received.map((r) => r.key).sort()).toEqual(["shots/a.png", "shots/b.png"]);
      expect(res.out).toBe(`http://${stub.host}/shots/`);
    } finally {
      stub.stop();
    }
  });

  test("an empty directory is an error, not an empty folder link", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await mkdir(join(dir, "nothing"));
      const res = await run(["nothing"]);
      expect(res.code).toBe(1);
      expect(res.err).toContain("no files in");
      expect(res.clipboard).toBe("");
    } finally {
      stub.stop();
    }
  });
});

describe("refusals", () => {
  // The capture path blocks on a human dragging a crosshair, so an agent reaching
  // it would hang until killed. A guard in code, not a warning in a doc.
  test("no arguments under CLAUDECODE refuses instead of hanging", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      const res = await run([], { CLAUDECODE: "1" });
      expect(res.code).toBe(1);
      expect(res.err).toContain("interactive");
      expect(res.err).toContain("screencapture -x -m");
      expect(stub.received).toHaveLength(0);
    } finally {
      stub.stop();
    }
  });

  // Same rule as hosts.ts: guessing would upload to the wrong organization.
  test("two hosts and no CDN_HOST names them and stops", async () => {
    await writeHost("cdn.example.com");
    await writeHost("files.work.example");
    await Bun.write(join(dir, "a.txt"), "a");
    const res = await run(["a.txt"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain("cdn.example.com");
    expect(res.err).toContain("files.work.example");
    expect(res.err).toContain("CDN_HOST");
  });

  test("no host at all names the path to create", async () => {
    await Bun.write(join(dir, "a.txt"), "a");
    const res = await run(["a.txt"]);
    expect(res.code).toBe(1);
    expect(res.err).toContain(hosts);
    expect(res.err).toContain("CDN_TOKEN");
  });

  test("CDN_HOST picks one of several, and CDN_TOKEN overrides the file", async () => {
    const stub = startStub();
    try {
      await writeHost("cdn.example.com", "personal");
      await writeHost(stub.host, "from-file");
      await Bun.write(join(dir, "a.txt"), "a");

      const viaFile = await run(["a.txt"], { CDN_HOST: stub.host });
      expect(viaFile.code).toBe(0);
      expect(stub.received[0]?.auth).toBe("Bearer from-file");

      const viaEnv = await run(["a.txt"], { CDN_HOST: stub.host, CDN_TOKEN: "from-env" });
      expect(viaEnv.code).toBe(0);
      expect(stub.received[1]?.auth).toBe("Bearer from-env");
    } finally {
      stub.stop();
    }
  });

  test("a missing file stops before any upload", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      await Bun.write(join(dir, "here.txt"), "here");
      const res = await run(["here.txt", "gone.txt"]);
      expect(res.code).toBe(1);
      expect(res.err).toContain("not found: gone.txt");
      expect(stub.received).toHaveLength(0);
    } finally {
      stub.stop();
    }
  });

  test("a rejected upload says which knob to turn, and copies nothing", async () => {
    const stub = startStub({ status: 401 });
    try {
      await writeHost(stub.host, "wrong");
      await Bun.write(join(dir, "a.txt"), "a");
      const res = await run(["a.txt"]);
      expect(res.code).toBe(1);
      expect(res.err).toContain("401");
      expect(res.err).toContain("CDN_TOKEN");
      expect(res.clipboard).toBe("");
    } finally {
      stub.stop();
    }
  });

  // A cancelled pick (ESC) still exits 0 from screencapture but writes nothing.
  // That is a cancel, not a failure: say nothing, leave the clipboard alone.
  test("a cancelled capture exits silently", async () => {
    const stub = startStub();
    try {
      await writeHost(stub.host);
      const res = await run([]);
      expect(res.code).toBe(0);
      expect(res.out).toBe("");
      expect(res.clipboard).toBe("");
      expect(stub.received).toHaveLength(0);
    } finally {
      stub.stop();
    }
  });
});
