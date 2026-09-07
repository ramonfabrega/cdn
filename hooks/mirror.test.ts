// End-to-end tests for the two mirror hooks, run in Bun (`bun test hooks/`).
//
// They spawn the real scripts and speak the real PostToolUse contract — JSON on
// stdin, one JSON line on stdout, exit 0 — because that contract IS the hook. A
// test that imported a function out of the script would pass while the script
// itself failed to parse stdin, which is the failure that actually happens.
//
// Hermetic: the CDN is a Bun.serve stub on a loopback port, which the hooks reach
// because `originFor` speaks http to loopback (that is also how you point a hook
// at `wrangler dev`). The spawned env is built from scratch, so an ambient
// CDN_HOST on the machine running the suite can never leak in.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { originFor, slugFor, upload } from "./lib.ts";

type Received = { key: string; auth: string | null; body: string };

type Stub = { stop: () => void; host: string; received: Received[] };

const startStub = ({ status = 200 }: { status?: number } = {}): Stub => {
  const received: Received[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/api/upload") return new Response("no such route", { status: 404 });
      const key = url.searchParams.get("key") ?? "";
      received.push({ key, auth: req.headers.get("authorization"), body: await req.text() });
      if (status >= 400) return new Response("nope", { status });
      // Shaped like the Worker's answer: it mints the url from the request it
      // answered, and the hooks trust that over building one themselves.
      return Response.json({ ok: true, key, url: `http://${url.host}/${key}`, permanent: false });
    },
  });
  return { stop: () => server.stop(true), host: `localhost:${server.port}`, received };
};

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cdn-mirror-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type HookResult = { code: number; out: string; err: string; json: Record<string, unknown> | null };

/** Run a hook the way Claude Code does: piped stdin, piped stdout, its own env. */
const runHook = async (
  script: "artifact-mirror.ts" | "user-file-mirror.ts",
  payload: unknown,
  env: Record<string, string> = {}
): Promise<HookResult> => {
  const proc = Bun.spawn([process.execPath, join(import.meta.dir, script)], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
    // Deliberately NOT {...process.env}: XDG_CONFIG_HOME points at the temp dir
    // so no real host file is visible, and nothing ambient can supply a token.
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      TMPDIR: dir,
      XDG_CONFIG_HOME: dir,
      ...env,
    },
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  let json: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(out);
    if (typeof parsed === "object" && parsed !== null) json = parsed as Record<string, unknown>;
  } catch {
    json = null;
  }
  return { code, out, err, json };
};

const contextOf = (r: HookResult) => {
  const hook = r.json?.hookSpecificOutput;
  return typeof hook === "object" && hook !== null && "additionalContext" in hook
    ? String(hook.additionalContext)
    : "";
};

describe("slugFor", () => {
  test("is stable per path, so re-sending the same file overwrites its copy", () => {
    expect(slugFor("/a/b/Report Card.png", "file")).toBe(slugFor("/a/b/Report Card.png", "file"));
    expect(slugFor("/a/b/shot.png", "file")).toStartWith("shot-");
  });

  test("two files sharing a basename never collide", () => {
    expect(slugFor("/one/shot.png", "file")).not.toBe(slugFor("/two/shot.png", "file"));
  });

  test("a name with nothing alphanumeric in it falls back", () => {
    expect(slugFor("/a/---.png", "file")).toStartWith("file-");
  });
});

describe("originFor", () => {
  // https everywhere except the one address that legitimately has no certificate.
  test("https for a real host, http for loopback", () => {
    expect(originFor("cdn.example.com")).toBe("https://cdn.example.com");
    expect(originFor("localhost:8787")).toBe("http://localhost:8787");
    expect(originFor("127.0.0.1:8787")).toBe("http://127.0.0.1:8787");
    expect(originFor("localhost.example.com")).toBe("https://localhost.example.com");
  });
});

describe("upload", () => {
  test("POSTs the bytes with the bearer and returns the Worker's own url", async () => {
    const stub = startStub();
    try {
      const src = join(dir, "a.txt");
      await Bun.write(src, "hello");
      const res = await upload({ host: stub.host, token: "t0ken" }, src, "sent/a.txt", 5_000);
      expect(res.error).toBeUndefined();
      // The url is the SERVER's, not one built here — the key went over the wire
      // percent-encoded and comes back as a path, which is the Worker's own shape.
      expect(res.url).toBe(`http://${stub.host}/sent/a.txt`);
      expect(stub.received).toHaveLength(1);
      expect(stub.received[0]?.auth).toBe("Bearer t0ken");
      expect(stub.received[0]?.key).toBe("sent/a.txt");
      expect(stub.received[0]?.body).toBe("hello");
    } finally {
      stub.stop();
    }
  });

  test("a 401 says which knob to turn", async () => {
    const stub = startStub({ status: 401 });
    try {
      const src = join(dir, "a.txt");
      await Bun.write(src, "hello");
      const res = await upload({ host: stub.host, token: "wrong" }, src, "sent/a.txt", 5_000);
      expect(res.url).toBeUndefined();
      expect(res.error).toContain("401");
      expect(res.error).toContain("CDN_TOKEN");
    } finally {
      stub.stop();
    }
  });

  test("an unreachable host is an error, not a throw", async () => {
    const src = join(dir, "a.txt");
    await Bun.write(src, "hello");
    // Port 1 on loopback: nothing listens, and the connection refusal is immediate.
    const res = await upload({ host: "127.0.0.1:1", token: "t" }, src, "sent/a.txt", 5_000);
    expect(res.url).toBeUndefined();
    expect(res.error).toContain("unreachable");
  });
});

describe("artifact-mirror", () => {
  const publish = (file: string) => ({ tool_input: { action: "publish", file_path: file } });

  test("wraps a head-less artifact in the publisher's skeleton, keeping its title", async () => {
    const stub = startStub();
    try {
      const src = join(dir, "sales-dashboard.html");
      await Bun.write(src, "<title>Sales Dashboard</title>\n<h1>Q3</h1>");
      const res = await runHook("artifact-mirror.ts", publish(src), {
        CDN_HOST: stub.host,
        CDN_TOKEN: "t0ken",
      });

      expect(res.code).toBe(0);
      expect(stub.received).toHaveLength(1);
      const sent = stub.received[0];
      // The artifact shape has no <head> of its own; without the wrapper the
      // mirror renders unstyled and unscaled on a phone.
      expect(sent?.body).toStartWith("<!doctype html>");
      expect(sent?.body).toContain('<meta name="viewport"');
      expect(sent?.body).toContain("<title>Sales Dashboard</title>");
      expect(sent?.body).toContain("<h1>Q3</h1>");
      expect(sent?.key).toStartWith("artifacts/sales-dashboard-");
      expect(sent?.key).toEndWith(".html");

      // Both halves of the PostToolUse contract, and the host is named — the
      // point of the phase: a mirror says where it went.
      expect(contextOf(res)).toContain(stub.host);
      expect(contextOf(res)).toContain(`http://${stub.host}/`);
      expect(String(res.json?.systemMessage)).toContain("Mirrored to http://");
    } finally {
      stub.stop();
    }
  });

  test("leaves a document that already has a doctype alone", async () => {
    const stub = startStub();
    try {
      const src = join(dir, "page.html");
      await Bun.write(
        src,
        "<!doctype html>\n<html><head><title>Mine</title></head><body>hi</body></html>"
      );
      await runHook("artifact-mirror.ts", publish(src), {
        CDN_HOST: stub.host,
        CDN_TOKEN: "t0ken",
      });
      const body = stub.received[0]?.body ?? "";
      expect(body.match(/<!doctype/gi)).toHaveLength(1);
      expect(body).toContain("<title>Mine</title>");
    } finally {
      stub.stop();
    }
  });

  test("ignores every action but publish — nothing local to mirror", async () => {
    const stub = startStub();
    try {
      const res = await runHook(
        "artifact-mirror.ts",
        { tool_input: { action: "read", url: "https://claude.ai/code/artifact/x" } },
        { CDN_HOST: stub.host, CDN_TOKEN: "t0ken" }
      );
      expect(res.code).toBe(0);
      expect(res.out).toBe("");
      expect(stub.received).toHaveLength(0);
    } finally {
      stub.stop();
    }
  });

  // The never-fail rule: no config is a line in the transcript, not a broken publish.
  test("no configured host skips with the path to create, and exits 0", async () => {
    const src = join(dir, "a.html");
    await Bun.write(src, "<h1>hi</h1>");
    const res = await runHook("artifact-mirror.ts", publish(src));
    expect(res.code).toBe(0);
    expect(contextOf(res)).toContain("CDN mirror skipped");
    expect(contextOf(res)).toContain(join(dir, "cdn", "hosts"));
  });

  test("a rejected upload is reported, and still exits 0", async () => {
    const stub = startStub({ status: 401 });
    try {
      const src = join(dir, "a.html");
      await Bun.write(src, "<h1>hi</h1>");
      const res = await runHook("artifact-mirror.ts", publish(src), {
        CDN_HOST: stub.host,
        CDN_TOKEN: "wrong",
      });
      expect(res.code).toBe(0);
      expect(contextOf(res)).toContain("CDN mirror failed");
      expect(contextOf(res)).toContain("401");
    } finally {
      stub.stop();
    }
  });

  test("reads its host from the hosts file when the env says nothing", async () => {
    const stub = startStub();
    try {
      await Bun.write(join(dir, "cdn", "hosts", `${stub.host}.env`), "CDN_TOKEN=from-file\n");
      const src = join(dir, "a.html");
      await Bun.write(src, "<h1>hi</h1>");
      const res = await runHook("artifact-mirror.ts", publish(src));
      expect(res.code).toBe(0);
      expect(stub.received[0]?.auth).toBe("Bearer from-file");
    } finally {
      stub.stop();
    }
  });
});

describe("user-file-mirror", () => {
  test("mirrors every file under sent/, keeping extensions, and lists the urls", async () => {
    const stub = startStub();
    try {
      await Bun.write(join(dir, "shot.png"), "png-bytes");
      await Bun.write(join(dir, "report.md"), "# report");
      const res = await runHook(
        "user-file-mirror.ts",
        { cwd: dir, tool_input: { files: [join(dir, "shot.png"), join(dir, "report.md")] } },
        { CDN_HOST: stub.host, CDN_TOKEN: "t0ken" }
      );

      expect(res.code).toBe(0);
      expect(stub.received).toHaveLength(2);
      const keys = stub.received.map((r) => r.key).sort();
      expect(keys[0]).toStartWith("sent/report-");
      expect(keys[0]).toEndWith(".md");
      expect(keys[1]).toStartWith("sent/shot-");
      expect(keys[1]).toEndWith(".png");
      expect(contextOf(res)).toContain(stub.host);
      expect(String(res.json?.systemMessage)).toContain("Mirrored 2 files");
    } finally {
      stub.stop();
    }
  });

  // The hook runs with its own working directory, so a relative path is only
  // meaningful against the cwd the payload reports.
  test("resolves relative paths against the payload's cwd, not its own", async () => {
    const stub = startStub();
    try {
      await Bun.write(join(dir, "rel.txt"), "relative");
      const res = await runHook(
        "user-file-mirror.ts",
        { cwd: dir, tool_input: { files: ["rel.txt"] } },
        { CDN_HOST: stub.host, CDN_TOKEN: "t0ken" }
      );
      expect(res.code).toBe(0);
      expect(stub.received[0]?.body).toBe("relative");
    } finally {
      stub.stop();
    }
  });

  test("one unreadable file doesn't stop the others", async () => {
    const stub = startStub();
    try {
      await Bun.write(join(dir, "good.txt"), "ok");
      const res = await runHook(
        "user-file-mirror.ts",
        { cwd: dir, tool_input: { files: ["good.txt", "missing.txt"] } },
        { CDN_HOST: stub.host, CDN_TOKEN: "t0ken" }
      );
      expect(res.code).toBe(0);
      expect(stub.received).toHaveLength(1);
      expect(contextOf(res)).toContain("Not mirrored");
      expect(contextOf(res)).toContain("missing.txt");
    } finally {
      stub.stop();
    }
  });

  test("no files at all is silent", async () => {
    const res = await runHook("user-file-mirror.ts", { cwd: dir, tool_input: { files: [] } });
    expect(res.code).toBe(0);
    expect(res.out).toBe("");
  });

  test("no configured host skips with the path to create, and exits 0", async () => {
    await Bun.write(join(dir, "good.txt"), "ok");
    const res = await runHook("user-file-mirror.ts", {
      cwd: dir,
      tool_input: { files: ["good.txt"] },
    });
    expect(res.code).toBe(0);
    expect(contextOf(res)).toContain("CDN mirror skipped");
    expect(contextOf(res)).toContain(join(dir, "cdn", "hosts"));
  });
});
