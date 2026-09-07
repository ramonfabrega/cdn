// `cdn setup`, driven against a stubbed Cloudflare.
//
// Every step is run in BOTH modes, because the promise `--dry-run` makes is not
// "it prints something plausible" — it is "this is what the real run will do".
// The only way that promise holds is if both modes take the same code path, so
// the tests assert on the pair: same verdicts modulo `created`/`skipped`, and
// nothing written when dry.

import { describe, expect, test } from "bun:test";

import { readOnlyFetch } from "../cloudflare.ts";
import { runSetup, type SetupReport } from "./index.ts";
import { type Command, type Runner, recordingRunner, runCommand } from "./wrangler.ts";

const ACCOUNT = "acc123";
const ZONE = { id: "zone123", name: "example.com" };
const DOMAIN = "cdn.example.com";
// The shape the reference's own example uses: 32 hex, not the Worker's name.
const WORKER_ID = "c81a2d22c29840ed9d61681a3270dbff";

const TEMPLATE = `{
  "name": "cdn-explorer",
  "main": "src/worker.ts",
  "compatibility_date": "2026-06-01",
  // No \`routes\` here: the zone belongs to whoever presses the button.
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "cdn" }]
}
`;

type App = {
  id: string;
  aud: string;
  domain: string;
  destinations?: { type: string; worker_id?: string; uri?: string }[];
};

type World = {
  zones: { id: string; name: string }[];
  browserCacheTtl: number;
  tokens: { id: string; name: string }[];
  apps: App[];
  /** What `GET /accounts/:id/workers/workers/:name` knows about. Empty is an
      account with nothing deployed; `undefined` is a token that cannot look. */
  workers?: { id: string; name: string }[];
  organization?: { auth_domain: string; name: string };
  writes: { method: string; url: string; body: unknown }[];
  /** What `wrangler secret list` answers. */
  secrets: string[];
  /** What the hosts file ended up holding, if anything. Never a real path — the
      writer is injected precisely so a test cannot reach ~/.config. */
  stored?: { host: string; token: string };
};

const emptyWorld = (): World => ({
  zones: [ZONE],
  browserCacheTtl: 14400,
  tokens: [],
  apps: [],
  workers: [{ id: WORKER_ID, name: "cdn-explorer" }],
  organization: { auth_domain: "acme.cloudflareaccess.com", name: "Acme" },
  writes: [],
  secrets: [],
});

/** A Cloudflare, in memory. Answers the shapes the docs showed, including the
    envelope — so a step that mishandles `{success,result}` fails here. */
const cloudflare = (world: World): typeof globalThis.fetch => {
  const json = (result: unknown) =>
    Response.json({ success: true, errors: [], messages: [], result });
  const wrapped = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const path = url.pathname.replace("/client/v4", "");
    const method = (init?.method ?? "GET").toUpperCase();
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (method !== "GET") world.writes.push({ method, url: path, body });

    if (method === "GET" && path === "/zones") {
      const name = url.searchParams.get("name");
      return json(world.zones.filter((z) => z.name === name));
    }
    if (path === `/zones/${ZONE.id}/settings/browser_cache_ttl`) {
      if (method === "PATCH") {
        // The real endpoint answers with the setting as it now stands, which is
        // what the step reads back rather than trusting its own request.
        const value = Reflect.get(Object(body), "value");
        if (typeof value === "number") world.browserCacheTtl = value;
      }
      if (method === "GET" || method === "PATCH") {
        return json({ id: "browser_cache_ttl", value: world.browserCacheTtl, editable: true });
      }
    }
    if (method === "GET" && path === `/accounts/${ACCOUNT}/tokens`) return json(world.tokens);
    if (method === "GET" && path === `/accounts/${ACCOUNT}/tokens/permission_groups`) {
      return json([
        { id: "pg-purge", name: "Cache Purge", scopes: ["com.cloudflare.api.account.zone"] },
        { id: "pg-other", name: "Cache Settings Write", scopes: [] },
      ]);
    }
    if (method === "POST" && path === `/accounts/${ACCOUNT}/tokens`) {
      world.tokens.push({ id: "tok1", name: String(Reflect.get(Object(body), "name")) });
      return json({ id: "tok1", value: "cfat_secret" });
    }
    if (method === "GET" && path === `/accounts/${ACCOUNT}/tokens/verify`) {
      return json({ id: "tok1", status: "active" });
    }
    if (method === "GET" && path === `/accounts/${ACCOUNT}/access/organizations`) {
      return world.organization
        ? json(world.organization)
        : new Response(JSON.stringify({ success: false, errors: [{ message: "not found" }] }), {
            status: 404,
          });
    }
    if (method === "GET" && path === `/accounts/${ACCOUNT}/access/apps`) {
      const domain = url.searchParams.get("domain");
      // No `domain` is the unfiltered listing — how a destination is looked up,
      // there being no query parameter for one.
      return json(domain === null ? world.apps : world.apps.filter((a) => a.domain === domain));
    }
    if (method === "POST" && path === `/accounts/${ACCOUNT}/access/apps`) {
      const domain = Reflect.get(Object(body), "domain");
      const destinations = Reflect.get(Object(body), "destinations");
      const app: App = {
        id: `app-${world.apps.length}`,
        aud: `aud-${world.apps.length}`,
        // Access answers with a domain whether or not one was sent.
        domain: typeof domain === "string" ? domain : "",
        ...(Array.isArray(destinations) ? { destinations } : {}),
      };
      world.apps.push(app);
      return json(app);
    }
    // "Identifier for the Worker, which can be ID or name" — the stub honours
    // both, because that is what the reference promises.
    const worker = /^\/accounts\/[^/]+\/workers\/workers\/(.+)$/.exec(path);
    if (method === "GET" && worker) {
      if (!world.workers) {
        return new Response(
          JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }),
          { status: 403 }
        );
      }
      const wanted = decodeURIComponent(worker[1] ?? "");
      const match = world.workers.find((w) => w.name === wanted || w.id === wanted);
      return match
        ? json({ id: match.id, name: match.name })
        : new Response(
            JSON.stringify({ success: false, errors: [{ message: "worker not found" }] }),
            { status: 404 }
          );
    }
    return new Response(
      JSON.stringify({ success: false, errors: [{ message: "no such route" }] }),
      {
        status: 404,
      }
    );
  };
  return wrapped as typeof globalThis.fetch;
};

type RunOptions = {
  dryRun?: boolean;
  access?: string[];
  accessHostname?: boolean;
  world?: World;
  config?: string;
};

/** The options `run` passes, exposed for the one test that needs its own fetch
    (a token that can read the zone setting but not write it). */
const baseOptions = (o: { world: World; fetch: typeof globalThis.fetch }) => ({
  domain: DOMAIN,
  access: [],
  accessHostname: false,
  dryRun: false,
  configPath: "wrangler.jsonc",
  accountId: ACCOUNT,
  cf: { token: "setup-token", fetch: o.fetch },
  run: wrangler(o.world, []),
  commands: [],
  storeToken: () => Promise.resolve({ ok: true as const, file: "/fake/hosts.env" }),
  readFile: () => Promise.resolve(TEMPLATE),
  writeFile: () => Promise.resolve(),
});

/** A wrangler, in memory. Only the READ has to answer anything real — that is
    the half a dry run still runs. */
const wrangler = (world: World, ranForReal: Command[]): Runner => {
  return (cmd) => {
    const argv = cmd.argv.join(" ");
    if (argv.startsWith("wrangler secret list")) {
      return Promise.resolve({
        code: 0,
        stdout: JSON.stringify(world.secrets.map((name) => ({ name, type: "secret_text" }))),
        stderr: "",
      });
    }
    ranForReal.push(cmd);
    if (cmd.argv[1] === "secret" && cmd.argv[2] === "put" && cmd.argv[3]) {
      world.secrets.push(cmd.argv[3]);
    }
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
};

const run = async (options: RunOptions = {}) => {
  const world = options.world ?? emptyWorld();
  const dryRun = options.dryRun === true;
  const files = new Map<string, string>([["wrangler.jsonc", options.config ?? TEMPLATE]]);
  const commands: Command[] = [];
  const ranForReal: Command[] = [];
  const inner = cloudflare(world);
  const real = wrangler(world, ranForReal);

  const report = await runSetup({
    domain: DOMAIN,
    access: options.access ?? [],
    accessHostname: options.accessHostname === true,
    dryRun,
    configPath: "wrangler.jsonc",
    accountId: ACCOUNT,
    cf: { token: "setup-token", fetch: dryRun ? readOnlyFetch([], inner) : inner },
    // Dry: writes recorded, reads passed through to the same fake wrangler the
    // real run uses — so `secret list` answers truthfully in both modes.
    run: dryRun ? recordingRunner(commands, real) : real,
    commands,
    storeToken: (host, token) => {
      world.stored = { host, token };
      return Promise.resolve({ ok: true as const, file: `/fake/config/cdn/hosts/${host}.env` });
    },
    readFile: (p) => {
      const text = files.get(p);
      return text === undefined ? Promise.reject(new Error("no such file")) : Promise.resolve(text);
    },
    writeFile: (p, text) => {
      files.set(p, text);
      return Promise.resolve();
    },
  });
  return { report, world, files, commands, ranForReal };
};

const verdicts = (report: SetupReport) =>
  Object.fromEntries(report.steps.map((s) => [s.step, s.verdict]));

describe("cdn setup, first run", () => {
  test("does every step, and says what it did", async () => {
    const { report, world, files, ranForReal } = await run();

    expect(verdicts(report)).toEqual({
      zone: "present",
      "custom domain": "created",
      "browser cache TTL": "created",
      "purge token": "created",
      "purge vars": "created",
      "upload token": "created",
      access: "skipped",
    });

    // The config gained a route and the purge vars, and kept its comments.
    const config = files.get("wrangler.jsonc") ?? "";
    expect(config).toContain(`"pattern": "${DOMAIN}"`);
    expect(config).toContain(`"CDN_ZONE_ID": "${ZONE.id}"`);
    expect(config).toContain(`"CDN_PUBLIC_ORIGIN": "https://${DOMAIN}"`);
    expect(config).toContain("the zone belongs to whoever presses the button");

    // The token is narrow: one permission, one zone, and account-owned.
    const mint = world.writes.find((w) => w.url === `/accounts/${ACCOUNT}/tokens`);
    expect(mint?.body).toEqual({
      name: `cdn purge (${DOMAIN})`,
      policies: [
        {
          effect: "allow",
          resources: { [`com.cloudflare.api.account.zone.${ZONE.id}`]: "*" },
          permission_groups: [{ id: "pg-purge" }],
        },
      ],
    });

    // The secret went in over stdin, not as an argument — an argument would put
    // it in a process list.
    // Named explicitly: setup now sets two secrets, and "the first one that
    // mentions `secret`" would quietly become whichever step runs first.
    const put = ranForReal.find((c) => c.argv.includes("CDN_PURGE_TOKEN"));
    expect(put?.argv).toEqual(["wrangler", "secret", "put", "CDN_PURGE_TOKEN"]);
    expect(put?.input).toBe("cfat_secret");
    expect(ranForReal.some((c) => c.argv.join(" ") === "wrangler deploy")).toBe(true);
  });

  // The promise --dry-run makes is "this is what the real run will do", and the
  // only way it holds is the same code path.
  test("--dry-run reaches the same verdicts and changes nothing", async () => {
    const { report, world, files, commands } = await run({ dryRun: true });

    expect(verdicts(report)).toEqual({
      zone: "present",
      "custom domain": "skipped",
      "browser cache TTL": "skipped",
      "purge token": "skipped",
      "purge vars": "skipped",
      "upload token": "skipped",
      access: "skipped",
    });
    // Nothing written: not the config, not the account.
    expect(files.get("wrangler.jsonc")).toBe(TEMPLATE);
    expect(world.writes).toEqual([]);
    expect(world.tokens).toEqual([]);
    expect(commands).toEqual([]);
    // But it still READ — a dry run whose reads were faked could only describe a
    // hypothetical account.
    expect(report.steps.find((s) => s.step === "zone")?.detail).toContain(ZONE.id);
  });
});

describe("idempotence", () => {
  test("a second run changes nothing and says everything is present", async () => {
    const first = await run();
    const config = first.files.get("wrangler.jsonc") ?? "";
    // Same account, same edited config — the state a re-run actually finds.
    first.world.writes.length = 0;
    const second = await run({ world: first.world, config });

    expect(verdicts(second.report)).toEqual({
      zone: "present",
      "custom domain": "present",
      "browser cache TTL": "present",
      "purge token": "present",
      "purge vars": "present",
      "upload token": "present",
      access: "skipped",
    });
    expect(second.world.writes).toEqual([]);
    expect(second.ranForReal).toEqual([]);
  });

  test("the commented-out route in the template does not count as present", async () => {
    // The trap: the template documents the very line setup adds. A check that
    // matched the comment would report `present` on a Worker answering on nobody's
    // domain.
    const { report } = await run();
    expect(verdicts(report)["custom domain"]).toBe("created");
  });
});

describe("browser cache TTL", () => {
  // Written now, because the integer is known. It was read off a zone already
  // set to "Respect Existing Headers" in the dashboard, which answered 0 — a
  // measurement of exactly the question the docs decline to answer.
  test("is set to respect existing headers, and says the zone it changed", async () => {
    const { report, world } = await run();
    const step = report.steps.find((s) => s.step === "browser cache TTL");
    expect(step?.verdict).toBe("created");
    expect(step?.detail).toContain("14400"); // what it was
    expect(world.browserCacheTtl).toBe(0);

    const patch = world.writes.find((w) => w.url.includes("browser_cache_ttl"));
    expect(patch?.method).toBe("PATCH");
    expect(patch?.body).toEqual({ value: 0 });
  });

  // The blast radius did not change when the uncertainty did: this is the one
  // step that reaches outside the CDN's own hostname, and a verdict that hid
  // that would be the wrong kind of quiet.
  test("names the whole zone, not just the CDN's hostname", async () => {
    const { report } = await run();
    const detail = report.steps.find((s) => s.step === "browser cache TTL")?.detail ?? "";
    expect(detail).toContain("every hostname on example.com");
    expect(detail).toContain("not only cdn.example.com");
  });

  test("--dry-run says what it would set and writes nothing", async () => {
    const { report, world } = await run({ dryRun: true });
    const step = report.steps.find((s) => s.step === "browser cache TTL");
    expect(step?.verdict).toBe("skipped");
    expect(step?.detail).toContain("Respect Existing Headers");
    expect(step?.detail).toContain("every hostname on example.com");
    expect(world.browserCacheTtl).toBe(14400);
    expect(world.writes).toEqual([]);
  });

  test("already-correct is reported as present, and nothing is written", async () => {
    const world = { ...emptyWorld(), browserCacheTtl: 0 };
    const { report } = await run({ world });
    expect(verdicts(report)["browser cache TTL"]).toBe("present");
    expect(world.writes.some((w) => w.url.includes("browser_cache_ttl"))).toBe(false);
  });

  // A token with Zone Settings Read but not Write is the likely failure, and the
  // step has to leave you able to finish the job by hand.
  test("a refused write fails loudly and hands back the two clicks", async () => {
    const world = emptyWorld();
    const inner = cloudflare(world);
    const denied: typeof globalThis.fetch = async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const method = (init?.method ?? "GET").toUpperCase();
      if (method === "PATCH" && url.includes("browser_cache_ttl")) {
        return new Response(
          JSON.stringify({ success: false, errors: [{ message: "Authentication error" }] }),
          { status: 403 }
        );
      }
      return inner(input, init);
    };
    const report = await runSetup(baseOptions({ world, fetch: denied }));
    const step = report.steps.find((s) => s.step === "browser cache TTL");
    expect(step?.verdict).toBe("failed");
    expect(step?.detail).toContain("Zone Settings Write");
    expect(step?.detail).toContain("by hand");
  });
});

describe("upload token", () => {
  // The credential every writer uses. Generated rather than asked for: 32 bytes
  // of hex is not something to put in front of a person, and a flow that does it
  // anyway gets a placeholder typed into it.
  test("is generated, set as a secret, and stored for this machine", async () => {
    const { report, world, ranForReal } = await run();
    const step = report.steps.find((s) => s.step === "upload token");
    expect(step?.verdict).toBe("created");

    const put = ranForReal.find((c) => c.argv.includes("CDN_UPLOAD_TOKEN"));
    expect(put?.argv).toEqual(["wrangler", "secret", "put", "CDN_UPLOAD_TOKEN"]);
    // Over stdin, never an argument — an argument is in the process list.
    expect(put?.input).toMatch(/^[0-9a-f]{64}$/);

    // The same token reached the hosts file, so the CLI works immediately.
    expect(world.stored?.host).toBe(DOMAIN);
    expect(world.stored?.token).toBe(put?.input);
  });

  // The one that matters: an existing token belongs to writers on machines that
  // are not this one, and replacing it breaks all of them at once, silently.
  test("an existing secret is never replaced", async () => {
    const world = { ...emptyWorld(), secrets: ["CDN_UPLOAD_TOKEN"] };
    const { report, world: after, ranForReal } = await run({ world });
    expect(verdicts(report)["upload token"]).toBe("present");
    expect(report.steps.find((s) => s.step === "upload token")?.detail).toContain("cdn auth login");
    expect(ranForReal.some((c) => c.argv.includes("CDN_UPLOAD_TOKEN"))).toBe(false);
    expect(after.stored).toBeUndefined();
  });

  // --dry-run READS for real here too, which is the whole point: on an instance
  // that already has a token it must say `present`, not "would generate one".
  test("--dry-run sees an existing token rather than promising a new one", async () => {
    const world = { ...emptyWorld(), secrets: ["CDN_UPLOAD_TOKEN"] };
    const { report, world: after } = await run({ dryRun: true, world });
    expect(verdicts(report)["upload token"]).toBe("present");
    expect(after.stored).toBeUndefined();
  });

  test("--dry-run on a fresh Worker promises one and writes nothing", async () => {
    const { report, world, commands } = await run({ dryRun: true });
    expect(verdicts(report)["upload token"]).toBe("skipped");
    expect(world.stored).toBeUndefined();
    expect(world.secrets).toEqual([]);
    expect(commands.some((c) => c.argv.includes("CDN_UPLOAD_TOKEN"))).toBe(false);
  });

  test("a token set on the Worker but not stored locally fails loudly", async () => {
    const world = emptyWorld();
    const files = new Map<string, string>([["wrangler.jsonc", TEMPLATE]]);
    const report = await runSetup({
      ...baseOptions({ world, fetch: cloudflare(world) }),
      storeToken: () => Promise.resolve({ ok: false as const, error: "ended up mode 644" }),
      readFile: (p: string) => Promise.resolve(files.get(p) ?? TEMPLATE),
      writeFile: () => Promise.resolve(),
    });
    const step = report.steps.find((s) => s.step === "upload token");
    expect(step?.verdict).toBe("failed");
    // The secret IS set, and it is only shown once — say what to do about that.
    expect(step?.detail).toContain("only shown once");
    expect(step?.detail).toContain("ended up mode 644");
  });
});

describe("access", () => {
  test("protects the WORKER by default — routes, custom domains and previews", async () => {
    const { report, world } = await run({ access: ["alice@example.com", "@example.com"] });

    expect(verdicts(report).access).toBe("created");
    expect(verdicts(report)["access bypass"]).toBe("created");
    expect(report.accessMode).toBe("worker");
    expect(report.accessTeam).toBe("acme");
    expect(report.accessAud).toBe("aud-0");

    const [explorer, bypass] = world.writes
      .filter((w) => w.url.endsWith("/access/apps"))
      .map((w) => w.body);

    // The Worker's immutable id, not its name — and no `domain`, because
    // destinations supersede it and the reference's example sends none.
    expect(explorer).toEqual({
      type: "self_hosted",
      name: "cdn explorer (cdn-explorer)",
      destinations: [{ type: "worker", worker_id: WORKER_ID }],
      session_duration: "24h",
      policies: [
        {
          name: "cdn explorer — allowed people",
          decision: "allow",
          include: [
            { email: { email: "alice@example.com" } },
            { email_domain: { domain: "example.com" } },
          ],
        },
      ],
    });

    // The bypass is the whole reason this is two applications: without it,
    // turning on Access answers every hook, the CLI and the Shortcut with a
    // login page instead of accepting their bearer. Against a Worker-level
    // application it has to say `public` out loud — that is the destination type
    // documented to take precedence over `worker`.
    expect(bypass).toMatchObject({
      domain: `${DOMAIN}/api/upload`,
      destinations: [{ type: "public", uri: `${DOMAIN}/api/upload` }],
      policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
    });

    // And the step says what it covers, because that is the whole difference.
    const detail = report.steps.find((s) => s.step === "access")?.detail ?? "";
    expect(detail).toContain("previews");
  });

  test("--dry-run says which shape it would make, and makes nothing", async () => {
    const { report, world } = await run({ access: ["@example.com"], dryRun: true });
    expect(verdicts(report).access).toBe("skipped");
    expect(report.accessMode).toBe("worker");
    // It still resolved the Worker for real — a dry run whose reads were faked
    // could not tell you which shape you are going to get.
    expect(report.steps.find((s) => s.step === "access")?.detail).toContain("cdn-explorer");
    expect(world.writes).toEqual([]);
  });

  test("a Worker this token cannot see falls back to the hostname, and says so", async () => {
    const world = emptyWorld();
    world.workers = undefined; // a token without Workers read
    const { report, world: after } = await run({ access: ["@example.com"], world });

    expect(verdicts(report).access).toBe("created");
    expect(report.accessMode).toBe("hostname");
    const detail = report.steps.find((s) => s.step === "access")?.detail ?? "";
    // The fallback is not silent: the preview URLs are outside this application.
    expect(detail).toContain("preview URLs keep answering to the password");
    expect(detail).toContain("could not resolve the Worker cdn-explorer");

    const [explorer, bypass] = after.writes
      .filter((w) => w.url.endsWith("/access/apps"))
      .map((w) => w.body);
    expect(explorer).toMatchObject({ type: "self_hosted", domain: DOMAIN });
    expect(Reflect.get(Object(explorer), "destinations")).toBeUndefined();
    // Two domain-shaped applications, no race to win, so the bypass keeps the
    // shape it shipped with.
    expect(Reflect.get(Object(bypass), "destinations")).toBeUndefined();
  });

  test("an account with nothing deployed yet is told to deploy first", async () => {
    const world = emptyWorld();
    world.workers = [];
    const { report } = await run({ access: ["@example.com"], world });
    expect(report.accessMode).toBe("hostname");
    expect(report.steps.find((s) => s.step === "access")?.detail).toContain(
      "no Worker named cdn-explorer"
    );
  });

  test("--access-hostname forces the hostname shape (Worker-level has no WebSockets)", async () => {
    const { report, world } = await run({ access: ["@example.com"], accessHostname: true });
    expect(report.accessMode).toBe("hostname");
    expect(report.steps.find((s) => s.step === "access")?.detail).toContain("--access-hostname");
    // And it never asked about the Worker at all.
    expect(world.writes.some((w) => w.url.includes("/workers/"))).toBe(false);
  });

  test("is skipped without --access, rather than guessing who should get in", async () => {
    const { report, world } = await run();
    expect(verdicts(report).access).toBe("skipped");
    expect(report.accessMode).toBeUndefined();
    expect(world.writes.some((w) => w.url.endsWith("/access/apps"))).toBe(false);
  });

  test("an account with no Zero Trust organization is told, not guessed at", async () => {
    const world = emptyWorld();
    world.organization = undefined;
    const { report } = await run({ access: ["@example.com"], world });
    const step = report.steps.find((s) => s.step === "access");
    expect(step?.verdict).toBe("manual");
    // Creating one picks a permanent team domain — not a thing to choose for
    // somebody.
    expect(step?.detail).toContain("permanent team domain");
  });

  test("an existing Worker application is matched by destination, not by name", async () => {
    const world = emptyWorld();
    world.apps = [
      // Renamed by hand in the dashboard, and on a different domain string —
      // still the application that protects this Worker.
      {
        id: "a",
        aud: "existing-aud",
        domain: "",
        destinations: [{ type: "worker", worker_id: WORKER_ID }],
      },
      { id: "b", aud: "bypass-aud", domain: `${DOMAIN}/api/upload` },
    ];
    const { report } = await run({ access: ["@example.com"], world });
    expect(verdicts(report).access).toBe("present");
    expect(verdicts(report)["access bypass"]).toBe("present");
    expect(report.accessAud).toBe("existing-aud");
    expect(world.writes.some((w) => w.url.endsWith("/access/apps"))).toBe(false);
  });

  test("an account-wide application is not mistaken for this Worker's", async () => {
    const world = emptyWorld();
    // `worker` takes precedence over `all_workers`, so the account-wide policy
    // is not the policy that was asked for — creating ours is the right move.
    world.apps = [{ id: "a", aud: "all-aud", domain: "", destinations: [{ type: "all_workers" }] }];
    const { report } = await run({ access: ["@example.com"], world });
    expect(verdicts(report).access).toBe("created");
    expect(report.accessAud).toBe("aud-1");
  });

  test("existing hostname applications are left alone", async () => {
    const world = emptyWorld();
    world.workers = undefined;
    world.apps = [
      { id: "a", aud: "existing-aud", domain: DOMAIN },
      { id: "b", aud: "bypass-aud", domain: `${DOMAIN}/api/upload` },
    ];
    const { report } = await run({ access: ["@example.com"], world });
    expect(verdicts(report).access).toBe("present");
    expect(verdicts(report)["access bypass"]).toBe("present");
    expect(report.accessAud).toBe("existing-aud");
  });

  test("a second run creates neither application again", async () => {
    const first = await run({ access: ["@example.com"] });
    first.world.writes.length = 0;
    const second = await run({ access: ["@example.com"], world: first.world });
    expect(verdicts(second.report).access).toBe("present");
    expect(verdicts(second.report)["access bypass"]).toBe("present");
    expect(second.world.writes).toEqual([]);
  });
});

describe("failing honestly", () => {
  test("a domain whose zone this token cannot see stops the run", async () => {
    const world = emptyWorld();
    world.zones = [];
    const { report, files } = await run({ world });
    expect(verdicts(report).zone).toBe("failed");
    expect(report.steps.find((s) => s.step === "zone")?.detail).toContain("CLOUDFLARE_API_TOKEN");
    // Nothing half-configured on the way out.
    expect(files.get("wrangler.jsonc")).toBe(TEMPLATE);
    expect(report.steps).toHaveLength(1);
  });

  test("every run names what it cannot do at all", async () => {
    const { report } = await run();
    expect(report.cannotDo).toHaveLength(2);
    expect(report.cannotDo.join(" ")).toContain("identity provider");
    expect(report.cannotDo.join(" ")).toContain("cannot see");
  });
});

describe("runCommand", () => {
  test("really runs a command and captures its output", async () => {
    const res = await runCommand({ argv: ["/bin/echo", "hello"] });
    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe("hello");
  });

  test("stdin is how a secret gets in — never an argument", async () => {
    const res = await runCommand({ argv: ["/bin/cat"], input: "s3cret" });
    expect(res.stdout).toBe("s3cret");
  });
});
