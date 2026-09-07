// Where a token lives: `~/.config/cdn/hosts/<host>.env`, one file per host, in
// dotenv (`CDN_TOKEN=…`), mode 0600.
//
// The format is chosen by its readers, not by taste. Three of them are meant to
// share these files — a Bun hook, a Bun CLI, and a bash script on a Mac with no
// `jq` — and dotenv is the only shape all three parse natively (wrangler's own
// `.dev.vars` is already it). One file per host rather than one file with
// sections, because "which host" is then a filename: `ls` is the list command
// and `rm` is the logout.
//
// Resolution follows clig.dev precedence — flags > env > config file. Flags
// belong to the CLI, which does not exist yet; here it is env > file, decided
// per variable:
//
//   CDN_HOST + CDN_TOKEN   both set → used as-is; no file has to exist at all
//   CDN_HOST               set      → names which file under hosts/
//   neither                         → exactly one *.env in hosts/ is the default
//
// Anything else is an error that names the path to create. Guessing between two
// configured hosts would mirror someone's file to the wrong organization, which
// is not a failure you want to discover from the recipient.
//
// There is no writer yet: `auth login` is the CLI's job. Create the file by hand
// — see the README.

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** A host and the bearer that writes to it. Everything else is derived. */
export type Target = { host: string; token: string };

/** Resolution never throws: the hooks that call it must never fail the tool they
    ran after, so a missing config is a value they can turn into one line of
    transcript. The error text always names the path to create. */
export type Resolution = { ok: true; target: Target } | { ok: false; error: string };

type Env = Record<string, string | undefined>;

export const hostsDir = (env: Env = process.env): string =>
  join(env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config"), "cdn", "hosts");

/** The dotenv subset every reader of these files can agree on: `KEY=value`, one
    per line, `#` comments, optional single or double quotes, an optional `export`
    prefix so the file can also be `source`d. No interpolation and no multi-line
    values — a bearer token has no use for either, and both are where the dotenv
    dialects disagree. */
export const parseDotenv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    const key = m?.[1];
    if (!key) continue; // blank, comment, or not an assignment
    const rest = (m?.[2] ?? "").trim();
    const quote = rest[0];
    out[key] =
      (quote === '"' || quote === "'") && rest.length > 1 && rest.endsWith(quote)
        ? rest.slice(1, -1)
        : rest.replace(/\s+#.*$/, "").trim(); // trailing comment, unquoted values only
  }
  return out;
};

const stem = (filename: string) => filename.replace(/\.env$/, "");

export async function resolveTarget(env: Env = process.env): Promise<Resolution> {
  const dir = hostsDir(env);
  const envHost = env.CDN_HOST?.trim() || undefined;
  const envToken = env.CDN_TOKEN?.trim() || undefined;

  // Both in the environment ⇒ the file is never consulted, so a CI job, a
  // container, or a one-off `CDN_HOST=… CDN_TOKEN=… ` invocation needs nothing
  // on disk.
  if (envHost && envToken) return { ok: true, target: { host: envHost, token: envToken } };

  let host = envHost;
  if (!host) {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((n) => n.endsWith(".env")).sort();
    } catch {
      return {
        ok: false,
        error: `no CDN host configured — create ${join(dir, "<host>.env")} containing CDN_TOKEN=…, or set CDN_HOST and CDN_TOKEN`,
      };
    }
    if (!names.length) {
      return {
        ok: false,
        error: `no CDN host configured — ${dir} holds no <host>.env file; create one containing CDN_TOKEN=…, or set CDN_HOST and CDN_TOKEN`,
      };
    }
    if (names.length > 1) {
      return {
        ok: false,
        error: `${names.length} hosts configured in ${dir} (${names.map(stem).join(", ")}) — set CDN_HOST to choose one`,
      };
    }
    host = stem(names[0] ?? "");
  }

  const file = join(dir, `${host}.env`);
  const text = await Bun.file(file)
    .text()
    .catch(() => null);
  if (text === null) {
    return { ok: false, error: `no token for ${host} — create ${file} containing CDN_TOKEN=…` };
  }
  // An env token still wins over the file's, per-variable: it is the override
  // you reach for to test a second credential without editing config.
  const token = envToken ?? parseDotenv(text).CDN_TOKEN?.trim();
  if (!token) return { ok: false, error: `${file} has no CDN_TOKEN=… line` };
  return { ok: true, target: { host, token } };
}
