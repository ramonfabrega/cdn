// `cdn setup` — the post-deploy checklist, run instead of read.
//
// The README has always ended the Deploy button with four manual steps. This is
// those steps, done, and the point is that they are IDEMPOTENT: every one checks
// before it acts, so running setup twice is not a different thing from running
// it once. That is what makes it safe to re-run after a partial failure, which is
// the state you are actually in when you need it most.
//
// Every step reports a verdict rather than throwing, and the whole run reports
// the list. A step that could not act says why and what to do by hand — the two
// things this command cannot do at all are printed at the end, because a
// checklist that quietly omits what it skipped is worse than no checklist.

import type { CloudflareOptions } from "../cloudflare.ts";
import {
  type AccessMode,
  createApp,
  explorerApp,
  findApp,
  findWorker,
  findWorkerApp,
  getOrganization,
  teamOf,
  uploadBypassApp,
  type WorkerRef,
  workerApp,
} from "./access.ts";
import {
  addPurgeVars,
  addRoute,
  type Command,
  hasRoute,
  hasVar,
  type Runner,
  routePatterns,
  workerName,
} from "./wrangler.ts";
import {
  browserCacheTtl,
  CACHE_PURGE_GROUP,
  createPurgeToken,
  findZone,
  listTokens,
  permissionGroup,
  RESPECT_EXISTING_HEADERS,
  setBrowserCacheTtl,
  verifyToken,
} from "./zone.ts";

/** What a step did.
 *
 *  present — already the case; nothing was changed
 *  created — setup did it
 *  skipped — a dry run, or the step was not asked for
 *  manual  — setup cannot do this, and says what you must
 *  failed  — it tried and could not
 */
export type Verdict = "present" | "created" | "skipped" | "manual" | "failed";
export type StepResult = { step: string; verdict: Verdict; detail: string };

export type SetupOptions = {
  domain: string;
  access: string[];
  /** Gate the hostname instead of the Worker. The escape hatch for the one
      documented case where Worker-level Access is the wrong tool: it does not
      support WebSocket connections, and a fork that adds them would get a 403 on
      every upgrade request. */
  accessHostname: boolean;
  dryRun: boolean;
  configPath: string;
  /** Read from `wrangler whoami`, never asked for. */
  accountId: string;
  cf: CloudflareOptions;
  run: Runner;
  /** Recorded when dry — printed as "what would have happened". */
  commands: Command[];
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, text: string) => Promise<void>;
};

export type SetupReport = {
  domain: string;
  dryRun: boolean;
  steps: StepResult[];
  /** Set once Access exists, because the Worker needs both to verify an
      assertion — printed so they can be added to wrangler.jsonc. */
  accessTeam?: string;
  accessAud?: string;
  /** Which shape of application the Access step made or found. `worker` covers
      the Worker's routes, Custom Domains, workers.dev hostname and previews;
      `hostname` covers the one hostname it names. */
  accessMode?: AccessMode;
  cannotDo: string[];
  commands: string[];
};

const step = (name: string, verdict: Verdict, detail: string): StepResult => ({
  step: name,
  verdict,
  detail,
});

/** The two things setup genuinely cannot do, printed every run. Naming them is
    the difference between a checklist and a false sense of completion. */
const CANNOT_DO = [
  "Configure a Google, Okta or other SSO identity provider — Access ships with Cloudflare's own login, and swapping it is a dashboard flow with a per-provider consent step.",
  "Touch a zone this token cannot see. If the domain is on another account, setup will not find its zone and will say so rather than half-configuring the Worker.",
];

export async function runSetup(options: SetupOptions): Promise<SetupReport> {
  const { domain, access, dryRun, cf, run, configPath, accountId } = options;
  const steps: StepResult[] = [];
  const report: SetupReport = {
    domain,
    dryRun,
    steps,
    cannotDo: [...CANNOT_DO],
    commands: [],
  };

  const config = await options.readFile(configPath).catch(() => null);
  if (config === null) {
    steps.push(step("wrangler.jsonc", "failed", `could not read ${configPath}`));
    return report;
  }

  // ── the zone ───────────────────────────────────────────────────────────────
  // Everything below needs it, and not finding it is the honest end of the run:
  // a domain on an account this token cannot see is not a thing to work around.
  const zone = await findZone(cf, domain);
  if (!zone.ok) {
    steps.push(step("zone", "failed", zone.error));
    return report;
  }
  if (!zone.result) {
    steps.push(
      step(
        "zone",
        "failed",
        `no zone on this account contains ${domain} — add the domain to Cloudflare first, or check that CLOUDFLARE_API_TOKEN can see it`
      )
    );
    return report;
  }
  const found = zone.result;
  steps.push(step("zone", "present", `${found.name} (${found.id})`));

  // ── a. the custom domain ───────────────────────────────────────────────────
  if (hasRoute(config)) {
    steps.push(
      step("custom domain", "present", `wrangler.jsonc routes: ${routePatterns(config).join(", ")}`)
    );
  } else {
    const edited = addRoute(config, domain);
    if (!edited.ok) {
      steps.push(step("custom domain", "failed", edited.error));
    } else if (dryRun) {
      steps.push(
        step("custom domain", "skipped", `would add a routes line for ${domain} and deploy`)
      );
    } else {
      await options.writeFile(configPath, edited.config);
      const deployed = await run({ argv: ["wrangler", "deploy"] });
      steps.push(
        deployed.code === 0
          ? step(
              "custom domain",
              "created",
              `${domain} — wrangler provisioned the DNS record and certificate`
            )
          : step(
              "custom domain",
              "failed",
              `wrangler deploy exited ${deployed.code}: ${deployed.stderr.trim().slice(0, 200)}`
            )
      );
    }
  }

  // ── b. browser cache TTL ───────────────────────────────────────────────────
  // Written, now that the integer is known — see RESPECT_EXISTING_HEADERS, which
  // was measured off a zone already set to that option rather than assumed. What
  // has not changed is the blast radius: this setting is ZONE-WIDE, so the
  // verdict names the zone and not the CDN's hostname. Nobody should learn from
  // a later surprise that `cdn setup` touched a whole domain.
  const ttl = await browserCacheTtl(cf, found.id);
  if (!ttl.ok) {
    steps.push(step("browser cache TTL", "failed", ttl.error));
  } else if (ttl.result === RESPECT_EXISTING_HEADERS) {
    steps.push(
      step("browser cache TTL", "present", `${found.name} already respects existing headers`)
    );
  } else if (dryRun) {
    steps.push(
      step(
        "browser cache TTL",
        "skipped",
        `would set ${found.name} to "Respect Existing Headers" (${RESPECT_EXISTING_HEADERS}) — currently ${ttl.result ?? "unknown"}s. Zone-wide: it affects every hostname on ${found.name}, not only ${domain}.`
      )
    );
  } else {
    const set = await setBrowserCacheTtl(cf, found.id);
    steps.push(
      set.ok && set.result === RESPECT_EXISTING_HEADERS
        ? step(
            "browser cache TTL",
            "created",
            `${found.name} now respects existing headers (was ${ttl.result ?? "unknown"}s). Zone-wide: this affects every hostname on ${found.name}, not only ${domain}.`
          )
        : step(
            "browser cache TTL",
            "failed",
            set.ok
              ? `asked for ${RESPECT_EXISTING_HEADERS} but ${found.name} came back as ${set.result ?? "unreadable"} — set Caching → Configuration → Browser Cache TTL to "Respect Existing Headers" by hand`
              : `${set.error} — needs Zone Settings Write; set Caching → Configuration → Browser Cache TTL to "Respect Existing Headers" by hand`
          )
    );
  }

  // ── c. the purge token ─────────────────────────────────────────────────────
  const tokenName = `cdn purge (${domain})`;
  const existing = await listTokens(cf, accountId);
  if (!existing.ok) {
    steps.push(step("purge token", "failed", existing.error));
  } else if (existing.result.some((t) => t.name === tokenName)) {
    steps.push(
      step("purge token", "present", `an account token named "${tokenName}" already exists`)
    );
  } else if (dryRun) {
    steps.push(
      step(
        "purge token",
        "skipped",
        `would mint an account token "${tokenName}" with only Cache Purge on ${found.name}`
      )
    );
  } else {
    const group = await permissionGroup(cf, accountId, CACHE_PURGE_GROUP);
    if (!group.ok) {
      steps.push(step("purge token", "failed", group.error));
    } else {
      const minted = await createPurgeToken(cf, accountId, found.id, group.result.id, tokenName);
      if (!minted.ok) {
        steps.push(step("purge token", "failed", minted.error));
      } else {
        // Verified at the ACCOUNT endpoint: the user one answers "invalid" for a
        // perfectly good cfat_ token, which is the most confusing thing about
        // account-owned tokens.
        const check = await verifyToken({ ...cf, token: minted.result.value }, accountId);
        const put = await run({
          argv: ["wrangler", "secret", "put", "CDN_PURGE_TOKEN"],
          input: minted.result.value,
        });
        steps.push(
          check.ok && put.code === 0
            ? step(
                "purge token",
                "created",
                `minted, verified, and stored as the CDN_PURGE_TOKEN secret`
              )
            : step(
                "purge token",
                "failed",
                check.ok
                  ? `minted and verified, but \`wrangler secret put\` exited ${put.code} — the secret is only shown once, so delete the token and re-run`
                  : `minted but did not verify: ${check.ok ? "" : check.error}`
              )
        );
      }
    }
  }

  // ── c2. the vars the purge needs ───────────────────────────────────────────
  if (hasVar(config, "CDN_ZONE_ID") && hasVar(config, "CDN_PUBLIC_ORIGIN")) {
    steps.push(
      step("purge vars", "present", "wrangler.jsonc already names the zone and the public origin")
    );
  } else if (dryRun) {
    steps.push(
      step(
        "purge vars",
        "skipped",
        `would add CDN_ZONE_ID=${found.id} and CDN_PUBLIC_ORIGIN=https://${domain}`
      )
    );
  } else {
    const current = await options.readFile(configPath);
    const edited = addPurgeVars(current, found.id, `https://${domain}`);
    if (!edited.ok) {
      steps.push(step("purge vars", "manual", edited.error));
    } else {
      await options.writeFile(configPath, edited.config);
      steps.push(step("purge vars", "created", "added to wrangler.jsonc — deploy to apply"));
    }
  }

  // ── d. Access ──────────────────────────────────────────────────────────────
  if (!access.length) {
    steps.push(
      step(
        "access",
        "skipped",
        "not requested — pass --access to gate the explorer with Zero Trust"
      )
    );
  } else {
    const org = await getOrganization(cf, accountId);
    if (!org) {
      steps.push(
        step(
          "access",
          "manual",
          "this account has no Zero Trust organization yet. Creating one picks a permanent team domain, which is not a thing to choose on your behalf — make it once in the Zero Trust dashboard, then re-run."
        )
      );
    } else {
      report.accessTeam = teamOf(org.authDomain);

      // WHICH SHAPE. A Worker-level application protects "every domain
      // associated with the Worker, including its routes, Custom Domains,
      // `workers.dev` hostname, and previews"; a hostname application protects
      // the hostname it names. So the Worker one is the default, and resolving
      // the Worker's id is the only thing that decides it.
      //
      // Failing to resolve it is a FALLBACK, not a failure. A token without
      // Workers read, an account where nothing is deployed yet, a name this
      // account knows differently — in every one of those the hostname
      // application is still the thing setup has always made, and it still
      // works. What changes is that the preview URLs stay outside it, so the
      // step says so rather than reporting the same sentence either way.
      const script = workerName(config);
      let worker: WorkerRef | undefined;
      let instead = "";
      if (options.accessHostname) {
        instead = "--access-hostname was passed";
      } else if (!script) {
        instead = "wrangler.jsonc names no Worker to protect";
      } else {
        const found = await findWorker(cf, accountId, script);
        if (!found.ok) instead = `could not resolve the Worker ${script}: ${found.error}`;
        else if (!found.result) {
          instead = `this account has no Worker named ${script} — deploy once, then re-run`;
        } else worker = found.result;
      }
      const mode: AccessMode = worker ? "worker" : "hostname";
      report.accessMode = mode;
      const scope = worker
        ? `the Worker ${worker.name} — its routes, Custom Domains, workers.dev hostname and previews`
        : `${domain} — that hostname only, so preview URLs keep answering to the password (${instead})`;

      const app = worker
        ? await findWorkerApp(cf, accountId, worker.id)
        : await findApp(cf, accountId, domain);
      if (!app.ok) {
        steps.push(step("access", "failed", app.error));
      } else if (app.result) {
        report.accessAud = app.result.aud;
        steps.push(step("access", "present", `an application already covers ${scope}`));
      } else if (dryRun) {
        steps.push(
          step("access", "skipped", `would protect ${scope}, allowing ${access.join(", ")}`)
        );
      } else {
        const spec = worker ? workerApp(worker, access) : explorerApp(domain, access);
        const created = await createApp(cf, accountId, spec);
        if (!created.ok) {
          steps.push(step("access", "failed", created.error));
        } else {
          report.accessAud = created.result.aud;
          steps.push(step("access", "created", `${scope} — allowing ${access.join(", ")}`));
        }
      }

      // The bypass, which is what keeps every writer working. Path-based Access
      // "applies first", ahead of both shapes above, which is the whole reason
      // this can be a second application rather than a hole in the first.
      const uploadPath = `${domain}/api/upload`;
      const bypass = await findApp(cf, accountId, uploadPath);
      if (!bypass.ok) {
        steps.push(step("access bypass", "failed", bypass.error));
      } else if (bypass.result) {
        steps.push(step("access bypass", "present", `an application already covers ${uploadPath}`));
      } else if (dryRun) {
        steps.push(
          step(
            "access bypass",
            "skipped",
            `would create a bypass application on ${uploadPath} so the upload bearer keeps working`
          )
        );
      } else {
        const created = await createApp(cf, accountId, uploadBypassApp(domain, mode));
        steps.push(
          created.ok
            ? step(
                "access bypass",
                "created",
                `${uploadPath} — bypassed, the bearer authenticates instead`
              )
            : step("access bypass", "failed", created.error)
        );
      }
    }
  }

  report.commands = options.commands.map((c) => c.argv.join(" "));
  return report;
}
