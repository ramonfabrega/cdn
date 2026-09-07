// The half of setup that talks to the local tree and to wrangler, rather than to
// Cloudflare's API.
//
// Two seams, for the same reason the API client has one: `--dry-run` has to take
// the SAME code path as a real run and merely record what it would do. A dry run
// that branches inside each step is a dry run that proves nothing about the step
// it is describing.

export type Command = { argv: string[]; input?: string };
export type Ran = { code: number; stdout: string; stderr: string };
export type Runner = (cmd: Command) => Promise<Ran>;

/** The real one. `input` goes to stdin, which is how `wrangler secret put` takes
    a secret without it appearing in a process list or a shell history. */
export const runCommand: Runner = async ({ argv, input }) => {
  const [file, ...args] = argv;
  if (!file) return { code: 1, stdout: "", stderr: "empty command" };
  const proc = Bun.spawn([file, ...args], {
    stdin: input === undefined ? "ignore" : new TextEncoder().encode(input),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
};

/** The dry-run one: records and answers success without doing anything. The
    recorded list is what gets printed, so what you read is literally what would
    have run. */
export const recordingRunner = (log: Command[]): Runner => {
  return (cmd) => {
    log.push(cmd);
    return Promise.resolve({ code: 0, stdout: "", stderr: "" });
  };
};

// ── wrangler.jsonc ───────────────────────────────────────────────────────────
// Edited as TEXT, not parsed and re-serialized. The file is mostly comments —
// every non-obvious decision in this project is explained in it — and a
// round-trip through JSON.parse would delete all of them. So: read whether a
// route is there, and if not, insert one line.

/** Does the config declare a real `routes` entry? A commented-out example does
    not count, which matters because the template ships with exactly that. */
export const hasRoute = (config: string): boolean =>
  config.split("\n").some((line) => /^\s*"routes"\s*:/.test(line));

/** Which patterns it declares, for reporting what is already configured. */
export const routePatterns = (config: string): string[] => {
  const line = config.split("\n").find((l) => /^\s*"routes"\s*:/.test(l));
  return line ? [...line.matchAll(/"pattern"\s*:\s*"([^"]+)"/g)].map((m) => m[1] ?? "") : [];
};

/**
 * Insert a custom-domain route. Anchored after `compatibility_date`, which every
 * wrangler config has and which sits above the bindings — so the route lands in
 * the same place a person would have typed it, and every comment survives.
 */
export const addRoute = (
  config: string,
  pattern: string
): { ok: true; config: string } | { ok: false; error: string } => {
  if (hasRoute(config)) return { ok: false, error: "wrangler.jsonc already declares routes" };
  const lines = config.split("\n");
  const at = lines.findIndex((l) => /^\s*"compatibility_date"\s*:/.test(l));
  if (at === -1) {
    return { ok: false, error: "could not find compatibility_date in wrangler.jsonc to anchor to" };
  }
  const indent = /^(\s*)/.exec(lines[at] ?? "")?.[1] ?? "  ";
  lines.splice(
    at + 1,
    0,
    "",
    `${indent}// Added by \`cdn setup\`: the Worker owns this hostname. wrangler`,
    `${indent}// provisions the DNS record and the certificate on deploy.`,
    `${indent}"routes": [{ "pattern": "${pattern}", "custom_domain": true }],`
  );
  return { ok: true, config: lines.join("\n") };
};

/** Does the config declare a var? Used to decide whether the purge vars need
    adding, and reported as `present` when they already are. */
export const hasVar = (config: string, name: string): boolean =>
  new RegExp(`"${name}"\\s*:`).test(config.replace(/^\s*\/\/.*$/gm, ""));

/**
 * Add the two vars the zone purge needs. Same text-preserving approach; inserted
 * as a whole `vars` block when there isn't one, because the template ships
 * without it — a fresh deploy has no zone to name.
 */
export const addPurgeVars = (
  config: string,
  zoneId: string,
  publicOrigin: string
): { ok: true; config: string } | { ok: false; error: string } => {
  if (hasVar(config, "CDN_ZONE_ID") && hasVar(config, "CDN_PUBLIC_ORIGIN")) {
    return { ok: false, error: "wrangler.jsonc already declares the purge vars" };
  }
  if (/^\s*"vars"\s*:/m.test(config.replace(/^\s*\/\/.*$/gm, ""))) {
    return {
      ok: false,
      error:
        "wrangler.jsonc already has a `vars` block — add CDN_ZONE_ID and CDN_PUBLIC_ORIGIN to it by hand",
    };
  }
  const lines = config.split("\n");
  const at = lines.findIndex((l) => /^\s*"compatibility_date"\s*:/.test(l));
  if (at === -1) {
    return { ok: false, error: "could not find compatibility_date in wrangler.jsonc to anchor to" };
  }
  const indent = /^(\s*)/.exec(lines[at] ?? "")?.[1] ?? "  ";
  lines.splice(
    at + 1,
    0,
    "",
    `${indent}// Added by \`cdn setup\`: with these plus the CDN_PURGE_TOKEN secret, a`,
    `${indent}// write invalidates every edge POP instead of only the one it ran in.`,
    `${indent}// Neither is a credential — the zone id is in every dashboard URL.`,
    `${indent}"vars": {`,
    `${indent}  "CDN_ZONE_ID": "${zoneId}",`,
    `${indent}  "CDN_PUBLIC_ORIGIN": "${publicOrigin}"`,
    `${indent}},`
  );
  return { ok: true, config: lines.join("\n") };
};

/** The Worker's name, which the deploy and the Access application both need and
    which the tree already knows. Read as text for the same reason as above. */
export const workerName = (config: string): string | undefined =>
  /^\s*"name"\s*:\s*"([^"]+)"/m.exec(config)?.[1];

/**
 * The account id, from `wrangler whoami`. Not asked for: the tree and the
 * logged-in session between them already know it, and a setup command that
 * interrogates you about things it can look up is a worse setup command.
 */
export const accountIdFrom = (whoami: string): string | undefined => {
  // wrangler prints a table; the id is the only 32-hex field in it.
  const ids = [...whoami.matchAll(/\b([0-9a-f]{32})\b/g)].map((m) => m[1] ?? "");
  return ids[0];
};

/**
 * The suffixes of a hostname that could be a zone, most specific first:
 * `cdn.example.co.uk` → itself, `example.co.uk`, `co.uk`.
 *
 * Deliberately not "strip to the last two labels". That is wrong for every
 * multi-part public suffix — `.co.uk`, `.com.au` — and getting it right in
 * general needs a public-suffix list, which is a dependency and a thing that
 * goes stale. Asking the API which of these it actually has is exact, costs at
 * most a couple of calls, and needs no data of ours to stay current.
 */
export const zoneCandidates = (host: string): string[] => {
  const parts = host.replace(/:\d+$/, "").split(".").filter(Boolean);
  if (parts.length < 2) return [];
  // Most specific first: a subdomain can be a zone in its own right, and if it
  // is, that is the one whose settings and purges apply to this hostname.
  const out = [parts.join(".")];
  for (let i = 1; i <= parts.length - 2; i++) out.push(parts.slice(i).join("."));
  return out;
};
