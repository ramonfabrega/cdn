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
  createApp,
  explorerApp,
  findApp,
  getOrganization,
  teamOf,
  uploadBypassApp,
} from "./access.ts";
import {
  addPurgeVars,
  addRoute,
  type Command,
  hasRoute,
  hasVar,
  type Runner,
  routePatterns,
} from "./wrangler.ts";
import {
  browserCacheTtl,
  CACHE_PURGE_GROUP,
  createPurgeToken,
  findZone,
  listTokens,
  permissionGroup,
  RESPECT_EXISTING_HEADERS,
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
  // Read, never written. See the long note on browserCacheTtl(): the integer
  // that means "Respect Existing Headers" is not documented, and this setting is
  // zone-wide, so a confident guess would change browser caching for every other
  // hostname on the domain.
  const ttl = await browserCacheTtl(cf, found.id);
  if (!ttl.ok) {
    steps.push(step("browser cache TTL", "failed", ttl.error));
  } else if (ttl.result === RESPECT_EXISTING_HEADERS) {
    steps.push(step("browser cache TTL", "present", "already respecting existing headers"));
  } else {
    steps.push(
      step(
        "browser cache TTL",
        "manual",
        `currently ${ttl.result ?? "unknown"}s. Set Caching → Configuration → Browser Cache TTL to "Respect Existing Headers" on ${found.name}. Not automated: which integer the API takes for that option is undocumented, and the setting is zone-wide.`
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
      // The explorer application.
      const app = await findApp(cf, accountId, domain);
      if (!app.ok) {
        steps.push(step("access", "failed", app.error));
      } else if (app.result) {
        report.accessAud = app.result.aud;
        steps.push(step("access", "present", `an application already covers ${domain}`));
      } else if (dryRun) {
        steps.push(
          step(
            "access",
            "skipped",
            `would create an Access application on ${domain} allowing ${access.join(", ")}`
          )
        );
      } else {
        const created = await createApp(cf, accountId, explorerApp(domain, access));
        if (!created.ok) {
          steps.push(step("access", "failed", created.error));
        } else {
          report.accessAud = created.result.aud;
          steps.push(step("access", "created", `${domain} — allowing ${access.join(", ")}`));
        }
      }

      // The bypass, which is what keeps every writer working.
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
        const created = await createApp(cf, accountId, uploadBypassApp(domain));
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
