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
import { type Command, recordingRunner, runCommand } from "./wrangler.ts";

const ACCOUNT = "acc123";
const ZONE = { id: "zone123", name: "example.com" };
const DOMAIN = "cdn.example.com";

const TEMPLATE = `{
  "name": "cdn-explorer",
  "main": "src/worker.ts",
  "compatibility_date": "2026-06-01",
  // No \`routes\` here: the zone belongs to whoever presses the button.
  "r2_buckets": [{ "binding": "BUCKET", "bucket_name": "cdn" }]
}
`;

type World = {
  zones: { id: string; name: string }[];
  browserCacheTtl: number;
  tokens: { id: string; name: string }[];
  apps: { id: string; aud: string; domain: string }[];
  organization?: { auth_domain: string; name: string };
  writes: { method: string; url: string; body: unknown }[];
};

const emptyWorld = (): World => ({
  zones: [ZONE],
  browserCacheTtl: 14400,
  tokens: [],
  apps: [],
  organization: { auth_domain: "acme.cloudflareaccess.com", name: "Acme" },
  writes: [],
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
    if (method === "GET" && path === `/zones/${ZONE.id}/settings/browser_cache_ttl`) {
      return json({ id: "browser_cache_ttl", value: world.browserCacheTtl, editable: true });
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
      return json(world.apps.filter((a) => a.domain === domain));
    }
    if (method === "POST" && path === `/accounts/${ACCOUNT}/access/apps`) {
      const domain = String(Reflect.get(Object(body), "domain"));
      const app = { id: `app-${world.apps.length}`, aud: `aud-${world.apps.length}`, domain };
      world.apps.push(app);
      return json(app);
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

type RunOptions = { dryRun?: boolean; access?: string[]; world?: World; config?: string };

const run = async (options: RunOptions = {}) => {
  const world = options.world ?? emptyWorld();
  const dryRun = options.dryRun === true;
  const files = new Map<string, string>([["wrangler.jsonc", options.config ?? TEMPLATE]]);
  const commands: Command[] = [];
  const ranForReal: Command[] = [];
  const inner = cloudflare(world);

  const report = await runSetup({
    domain: DOMAIN,
    access: options.access ?? [],
    dryRun,
    configPath: "wrangler.jsonc",
    accountId: ACCOUNT,
    cf: { token: "setup-token", fetch: dryRun ? readOnlyFetch([], inner) : inner },
    run: dryRun
      ? recordingRunner(commands)
      : (cmd) => {
          ranForReal.push(cmd);
          return Promise.resolve({ code: 0, stdout: "", stderr: "" });
        },
    commands,
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
      "browser cache TTL": "manual",
      "purge token": "created",
      "purge vars": "created",
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
    const put = ranForReal.find((c) => c.argv.includes("secret"));
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
      "browser cache TTL": "manual",
      "purge token": "skipped",
      "purge vars": "skipped",
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
      "browser cache TTL": "manual",
      "purge token": "present",
      "purge vars": "present",
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
  // Read, never written: the integer meaning "Respect Existing Headers" is not
  // documented, and the setting is zone-wide.
  test("is reported as manual, with the current value and the reason", async () => {
    const { report, world } = await run();
    const step = report.steps.find((s) => s.step === "browser cache TTL");
    expect(step?.verdict).toBe("manual");
    expect(step?.detail).toContain("14400");
    expect(step?.detail).toContain("Respect Existing Headers");
    expect(step?.detail).toContain("zone-wide");
    // And nothing was PATCHed at it.
    expect(world.writes.some((w) => w.url.includes("browser_cache_ttl"))).toBe(false);
  });

  test("already-correct is reported as present", async () => {
    const world = { ...emptyWorld(), browserCacheTtl: 0 };
    const { report } = await run({ world });
    expect(verdicts(report)["browser cache TTL"]).toBe("present");
  });
});

describe("access", () => {
  test("creates the explorer app and the upload bypass, and reports both", async () => {
    const { report, world } = await run({ access: ["alice@example.com", "@example.com"] });

    expect(verdicts(report).access).toBe("created");
    expect(verdicts(report)["access bypass"]).toBe("created");
    expect(report.accessTeam).toBe("acme");
    expect(report.accessAud).toBe("aud-0");

    const [explorer, bypass] = world.writes
      .filter((w) => w.url.endsWith("/access/apps"))
      .map((w) => w.body);

    // One person and a whole domain, in the selectors the docs specify.
    expect(explorer).toMatchObject({
      type: "self_hosted",
      domain: DOMAIN,
      policies: [
        {
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
    // login page instead of accepting their bearer.
    expect(bypass).toMatchObject({
      domain: `${DOMAIN}/api/upload`,
      policies: [{ decision: "bypass", include: [{ everyone: {} }] }],
    });
  });

  test("is skipped without --access, rather than guessing who should get in", async () => {
    const { report, world } = await run();
    expect(verdicts(report).access).toBe("skipped");
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

  test("existing applications are left alone", async () => {
    const world = emptyWorld();
    world.apps = [
      { id: "a", aud: "existing-aud", domain: DOMAIN },
      { id: "b", aud: "bypass-aud", domain: `${DOMAIN}/api/upload` },
    ];
    const { report } = await run({ access: ["@example.com"], world });
    expect(verdicts(report).access).toBe("present");
    expect(verdicts(report)["access bypass"]).toBe("present");
    expect(report.accessAud).toBe("existing-aud");
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
