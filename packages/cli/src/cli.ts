// `cdn` — the agent-facing projection of the upload API.
//
// Deliberately small. The Worker is the product; this is one of four front ends
// onto the same `POST /api/upload` (the others being the explorer's drop zone,
// two Claude Code hooks, and a macOS Shortcut), and it exists because a session
// or a script wants typed arguments, a `--json` envelope, and an error that says
// which command fixes it.
//
// Built on incur, which is the reason there is no argument parsing, no help
// text, no output formatting and no skill file in here: schemas produce all four.
//
// What it deliberately does NOT have:
//
//   ls — listing needs a machine-readable folder manifest, and publishing one
//        makes the whole bucket enumerable. That is README open thread 1, gated
//        on thread 2 (deciding what should be enumerable at all). A CLI verb is
//        not the place to settle it.
//   rm — the destructive routes take the session cookie, not the upload bearer,
//        and that is on purpose: this token is a machine credential that can add
//        but not remove. Deleting is the explorer's job, where a human confirms.
//
// Both are said in `--help` rather than left to be discovered.

import { Cli, z } from "incur";

import { readOnlyFetch } from "./cloudflare.ts";
import { hostsDir, listHosts, resolveTarget } from "./hosts.ts";
import { humanSize, keyForFile, keyInDir, prefixForDir, walk } from "./keys.ts";
import { writeHostFile } from "./login.ts";
import { runSetup } from "./setup/index.ts";
import { accountIdFrom, type Command, recordingRunner, runCommand } from "./setup/wrangler.ts";
import { upload, verify } from "./upload.ts";

// The CLI's whole environment, declared. The two CDN_* vars are the documented
// overrides; the two path vars are here because they decide WHERE host files are
// read and written, and a command that can write a credential should not reach
// around its own declared inputs to find out where. Declaring them also means
// incur's `serve(argv, { env })` is a total seam: a test cannot accidentally
// touch the real ~/.config, which is not a hypothetical — it happened once while
// this file was being written.
const ENV = z.object({
  CDN_HOST: z.string().optional().describe("Which host to talk to; overrides the hosts file"),
  CDN_TOKEN: z.string().optional().describe("Upload bearer; overrides the host file's"),
  XDG_CONFIG_HOME: z.string().optional().describe("Where host files live; defaults to ~/.config"),
  HOME: z.string().optional().describe("Used to locate ~/.config when XDG_CONFIG_HOME is unset"),
});

type CdnEnv = z.infer<typeof ENV>;

/** `--host` is the flag half of clig.dev precedence (flags > env > config), and
    the only way to apply it is to make the environment say so before resolution
    reads it. */
const resolve = async (env: CdnEnv, host?: string) =>
  resolveTarget(host ? { ...env, CDN_HOST: host } : env);

const authCta = (host?: string) => ({
  description: "To authenticate:",
  commands: [
    {
      command: "auth login",
      description: host ? `Store a token for ${host}` : "Store a token for a host",
    },
    { command: "auth status", description: "Show which host would be used, and why" },
  ],
});

export const cli = Cli.create("cdn", {
  version: "0.1.0",
  description: "Upload files to your own CDN — one authenticated POST, and the URL comes back.",
  sync: {
    body:
      "The host and token come from `~/.config/cdn/hosts/<host>.env`. " +
      "Run `cdn auth status` to see which one is in effect and why.",
    suggestions: [
      "upload this screenshot and give me the link",
      "put the build output under releases/ and keep it forever",
    ],
  },
});

cli.command("up", {
  description: "Upload a file or a directory and print the URL the CDN returns",
  args: z.object({
    path: z.string().describe("File or directory to upload"),
    dest: z
      .string()
      .optional()
      .describe(
        "Where to put it: a trailing slash is a namespace (`notes/`), anything else is the exact key"
      ),
  }),
  options: z.object({
    permanent: z
      .boolean()
      .optional()
      .describe("Exempt from the 30-day expiry sweep. Sticks across later overwrites of the key"),
    host: z.string().optional().describe("Upload to this host instead of the configured default"),
  }),
  alias: { permanent: "p" },
  env: ENV,
  output: z.object({
    url: z.string().describe("Public URL — the file's own, or the folder page for a directory"),
    key: z.string().describe("Object key, or the prefix a directory landed under"),
    files: z.number().describe("Objects written"),
    bytes: z.number().describe("Total bytes uploaded"),
    permanent: z.boolean().describe("Whether the object is exempt from the expiry sweep"),
  }),
  examples: [
    { args: { path: "shot.png" }, description: "One file, random slug, real extension" },
    { args: { path: "shot.png", dest: "notes/" }, description: "Into a namespace" },
    { args: { path: "shot.png", dest: "notes/hero.png" }, description: "At an exact key" },
    { args: { path: "./dist" }, description: "A directory, served as a listing page" },
    {
      args: { path: "app.zip", dest: "releases/app.zip" },
      options: { permanent: true },
      description: "Something that must outlive the sweep",
    },
  ],
  hint: "No `ls` or `rm`: the upload bearer can add but not remove, and listing is a decision this project has not made yet (see README open threads).",
  async run(c) {
    const resolved = await resolve(c.env, c.options.host);
    if (!resolved.ok) {
      return c.error({
        code: "NOT_AUTHENTICATED",
        message: resolved.error,
        retryable: true,
        cta: authCta(c.options.host),
      });
    }
    const target = resolved.target;

    const file = Bun.file(c.args.path);
    const stat = await file.stat().catch(() => null);
    if (!stat) {
      return c.error({
        code: "NOT_FOUND",
        message: `not found: ${c.args.path}`,
        retryable: false,
      });
    }

    const permanent = c.options.permanent === true;
    const opts = { permanent, timeoutMs: 600_000 };

    // ── a directory ──────────────────────────────────────────────────────────
    if (stat.isDirectory()) {
      const files = await walk(c.args.path);
      if (!files.length) {
        return c.error({
          code: "EMPTY_DIRECTORY",
          message: `no files under ${c.args.path}`,
          retryable: false,
        });
      }
      const prefix = prefixForDir(c.args.path, c.args.dest);
      let bytes = 0;
      let first = "";
      for (const [i, src] of files.entries()) {
        const key = keyInDir(prefix, c.args.path, src);
        // Progress on stderr, and only for a person: stdout is the envelope an
        // agent parses, and an agent reading a progress line as data is the bug
        // this rule exists to prevent.
        if (!c.agent) process.stderr.write(`\r[${i + 1}/${files.length}] ${key}\x1b[K`);
        const res = await upload(target, src, key, opts);
        if (!res.ok) {
          if (!c.agent) process.stderr.write("\n");
          return c.error({
            code: "UPLOAD_FAILED",
            message: res.error,
            retryable: true,
            ...(res.error.includes("401") ? { cta: authCta(target.host) } : {}),
          });
        }
        bytes += Bun.file(src).size;
        if (!first) first = res.uploaded.url;
      }
      if (!c.agent) process.stderr.write("\n");
      // The folder URL is derived from a URL the Worker minted, not composed:
      // scheme and host off the first upload's answer, then the prefix. Nothing
      // in this repo builds a public URL out of a domain string.
      const origin = new URL(first).origin;
      return c.ok({
        url: `${origin}/${prefix}`,
        key: prefix,
        files: files.length,
        bytes,
        permanent,
      });
    }

    // ── one file ─────────────────────────────────────────────────────────────
    const key = keyForFile(c.args.path, c.args.dest);
    if (!c.agent && stat.size > 5 * 1024 ** 2) {
      process.stderr.write(`uploading ${humanSize(stat.size)}…\n`);
    }
    const res = await upload(target, c.args.path, key, opts);
    if (!res.ok) {
      return c.error({
        code: "UPLOAD_FAILED",
        message: res.error,
        retryable: true,
        ...(res.error.includes("401") ? { cta: authCta(target.host) } : {}),
      });
    }
    return c.ok({
      url: res.uploaded.url,
      key: res.uploaded.key,
      files: 1,
      bytes: stat.size,
      permanent: res.uploaded.permanent,
    });
  },
});

const auth = Cli.create("auth", {
  description: "Manage which host you upload to, and the token that lets you",
});

auth.command("login", {
  description: "Verify a token and store it at ~/.config/cdn/hosts/<host>.env, mode 0600",
  options: z.object({
    host: z.string().describe("The CDN host, e.g. cdn.example.com — becomes the filename"),
    token: z
      .string()
      .optional()
      .describe("The upload bearer. Prompted for when omitted, if there is a terminal to ask"),
  }),
  env: ENV,
  output: z.object({
    host: z.string(),
    file: z.string().describe("Where the token was written"),
    mode: z.string().describe("The file's permissions, as octal"),
    contract: z.number().describe("The API contract version the host speaks"),
  }),
  examples: [
    { options: { host: "cdn.example.com" }, description: "Prompt for the token" },
    {
      options: { host: "cdn.example.com", token: "…" },
      description: "Non-interactive, e.g. from a secret manager",
    },
  ],
  hint: "The token is CDN_UPLOAD_TOKEN on the Worker. Get it from `wrangler secret list` — or set it with `wrangler secret put CDN_UPLOAD_TOKEN`.",
  async run(c) {
    let token = c.options.token?.trim();
    if (!token) {
      // Refusing to prompt without a terminal is the difference between a clear
      // failure and a script that hangs forever in CI waiting for stdin.
      if (c.agent || !process.stdin.isTTY) {
        return c.error({
          code: "TOKEN_REQUIRED",
          message: "no token given and no terminal to ask — pass --token",
          retryable: false,
        });
      }
      process.stderr.write(`Upload token for ${c.options.host}: `);
      token = (await new Response(Bun.stdin.stream()).text()).trim().split("\n")[0]?.trim();
    }
    if (!token) {
      return c.error({ code: "TOKEN_REQUIRED", message: "no token given", retryable: false });
    }

    // Verify BEFORE writing. A token file that doesn't work is worse than no
    // token file: it turns "you're not logged in" into "uploads mysteriously
    // fail", and the handshake also tells us whether the two sides agree on a
    // contract at all.
    const checked = await verify({ host: c.options.host, token });
    if (!checked.ok) {
      return c.error({
        code: "VERIFICATION_FAILED",
        message: checked.error,
        retryable: true,
      });
    }

    const written = await writeHostFile(c.options.host, token, c.env);
    if (!written.ok) {
      return c.error({ code: "WRITE_FAILED", message: written.error, retryable: false });
    }

    return c.ok(
      {
        host: c.options.host,
        file: written.file,
        mode: written.mode.toString(8).padStart(4, "0"),
        contract: checked.contract,
      },
      {
        cta: {
          description: "Ready:",
          commands: [
            { command: "up", description: "Upload a file" },
            { command: "auth status", description: "See every configured host" },
          ],
        },
      }
    );
  },
});

auth.command("status", {
  description: "Show every configured host, which one is in effect, and why",
  options: z.object({
    host: z.string().optional().describe("Resolve as if this host had been asked for"),
  }),
  env: ENV,
  output: z.object({
    dir: z.string().describe("Where host files live"),
    hosts: z.array(
      z.object({
        host: z.string(),
        file: z.string(),
        mode: z.string().describe("Permissions as octal; 0600 is what login writes"),
        secure: z.boolean().describe("False when the group or the world can read the token"),
        active: z.boolean().describe("Whether this is the host that would be used"),
      })
    ),
    active: z.string().optional().describe("The host that would be used, if one resolves"),
    why: z.string().describe("The precedence step that decided, in words"),
  }),
  hint: "Precedence is flags > env > config file: --host beats CDN_HOST, which beats the sole file in the hosts directory.",
  async run(c) {
    const files = await listHosts(c.env);
    const resolved = await resolve(c.env, c.options.host);
    const active = resolved.ok ? resolved.target : undefined;

    // The whole point of this command is to answer "why is it uploading THERE",
    // so the answer is a sentence naming the step, not a bare hostname.
    const why = !active
      ? resolved.ok
        ? ""
        : resolved.error
      : c.options.host
        ? `--host ${c.options.host}`
        : active.source === "env"
          ? "CDN_HOST and CDN_TOKEN are both set in the environment; no file was read"
          : active.source === "CDN_HOST"
            ? `CDN_HOST names ${active.file}`
            : `${active.file} is the only host file in ${hostsDir(c.env)}`;

    const tokenNote =
      active && active.source !== "env" && active.tokenFrom === "env"
        ? " (token overridden by CDN_TOKEN)"
        : "";

    const insecure = files.filter((f) => !f.secure);
    return c.ok(
      {
        dir: hostsDir(c.env),
        hosts: files.map((f) => ({
          host: f.host,
          file: f.file,
          mode: f.mode.toString(8).padStart(4, "0"),
          secure: f.secure,
          active: f.host === active?.host,
        })),
        ...(active ? { active: active.host } : {}),
        why: why + tokenNote,
      },
      insecure.length
        ? {
            cta: {
              // A warning here, a refusal in `login`: this command's job is to
              // tell you the truth about what is on disk, not to withhold it.
              description: `Readable by others — rotate and re-login: ${insecure.map((f) => f.host).join(", ")}`,
              commands: [{ command: "auth login", description: "Rewrite the file as 0600" }],
            },
          }
        : undefined
    );
  },
});

cli.command(auth);

cli.command("setup", {
  description: "Do the post-deploy checklist: custom domain, purge token, and optionally Access",
  options: z.object({
    domain: z.string().describe("The hostname this Worker should own, e.g. cdn.example.com"),
    access: z
      .array(z.string())
      .optional()
      .describe(
        "Gate the explorer with Cloudflare Access. An email, or @domain for everyone there"
      ),
    accessHostname: z
      .boolean()
      .optional()
      .describe(
        "Gate the hostname instead of the Worker. Worker-level Access does not support WebSockets"
      ),
    dryRun: z.boolean().optional().describe("Say what would happen and change nothing"),
    config: z.string().optional().describe("Path to wrangler.jsonc (default: ./wrangler.jsonc)"),
  }),
  // HOME and XDG_CONFIG_HOME are declared because this command can WRITE a
  // credential: the generated upload token lands in the hosts file, and a
  // command that writes one should not reach around its own declared inputs to
  // decide where. The lesson is paid for — an earlier partial seam let a test
  // touch the real ~/.config, and a partial env seam is worse than none because
  // it looks total.
  env: z.object({
    CLOUDFLARE_API_TOKEN: z
      .string()
      .optional()
      .describe("The broad setup token. Read from the environment only — never written anywhere"),
    XDG_CONFIG_HOME: z.string().optional().describe("Where host files live; defaults to ~/.config"),
    HOME: z.string().optional().describe("Used to locate ~/.config when XDG_CONFIG_HOME is unset"),
  }),
  output: z.object({
    domain: z.string(),
    dryRun: z.boolean(),
    steps: z.array(
      z.object({
        step: z.string(),
        verdict: z.enum(["present", "created", "skipped", "manual", "failed"]),
        detail: z.string(),
      })
    ),
    accessTeam: z
      .string()
      .optional()
      .describe("Add as CDN_ACCESS_TEAM to let the Worker verify assertions"),
    accessAud: z.string().optional().describe("Add as CDN_ACCESS_AUD alongside it"),
    accessMode: z
      .enum(["worker", "hostname"])
      .optional()
      .describe(
        "worker covers routes, custom domains, workers.dev and previews; hostname does not"
      ),
    cannotDo: z.array(z.string()).describe("What this command cannot do, every run"),
    commands: z.array(z.string()).describe("On a dry run, the commands that would have run"),
  }),
  examples: [
    { options: { domain: "cdn.example.com", dryRun: true }, description: "See what it would do" },
    { options: { domain: "cdn.example.com" }, description: "Domain, purge token, cache check" },
    {
      options: { domain: "cdn.example.com", access: ["@example.com"] },
      description: "…and gate the Worker for everyone at example.com, previews included",
    },
  ],
  hint: "Needs CLOUDFLARE_API_TOKEN — one broad token, used once, never stored. It is NOT the purge token: that one is narrow, account-owned, and minted by this command.",
  async run(c) {
    const token = c.env.CLOUDFLARE_API_TOKEN?.trim();
    if (!token) {
      return c.error({
        code: "NO_API_TOKEN",
        message:
          "CLOUDFLARE_API_TOKEN is not set. Create a token with the permissions in the README's setup table, and pass it for this one run — setup never writes it anywhere.",
        retryable: false,
      });
    }

    const configPath = c.options.config ?? "wrangler.jsonc";
    // The account id comes from the session, not from you. `--json` is the
    // documented structured form; the id is 32 hex either way, so one regex
    // reads both and there is no second parser to keep true.
    const whoami = await runCommand({ argv: ["wrangler", "whoami", "--json"] });
    const accountId = accountIdFrom(`${whoami.stdout}\n${whoami.stderr}`);
    if (!accountId) {
      return c.error({
        code: "NOT_LOGGED_IN",
        message: "could not read an account id from `wrangler whoami` — run `wrangler login` first",
        retryable: true,
      });
    }

    const commands: Command[] = [];
    const dryRun = c.options.dryRun === true;
    const report = await runSetup({
      domain: c.options.domain,
      access: c.options.access ?? [],
      accessHostname: c.options.accessHostname === true,
      dryRun,
      configPath,
      accountId,
      cf: { token, ...(dryRun ? { fetch: readOnlyFetch() } : {}) },
      run: dryRun ? recordingRunner(commands) : runCommand,
      commands,
      storeToken: (host, token) => writeHostFile(host, token, c.env),
      readFile: (p) => Bun.file(p).text(),
      writeFile: (p, text) => Bun.write(p, text).then(() => undefined),
    });

    // The checklist IS the result: incur renders it for a person and hands the
    // same object to an agent, so there is no second formatter to drift.
    const failed = report.steps.some((s) => s.verdict === "failed");
    return failed
      ? c.error({
          code: "SETUP_INCOMPLETE",
          message: report.steps
            .filter((s) => s.verdict === "failed")
            .map((s) => `${s.step}: ${s.detail}`)
            .join("; "),
          retryable: true,
        })
      : c.ok(report);
  },
});

export default cli;
