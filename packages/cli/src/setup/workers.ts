// The Worker's own resources — the account it lives on, and its secrets —
// through the API rather than through `wrangler`.
//
// WHY NOT WRANGLER. Setup used to shell out for three of these: `wrangler
// whoami` for the account id, `wrangler secret list` to see whether a credential
// already existed, and `wrangler secret put` to set one. That looked free —
// wrangler is already installed, and it already holds a login — but it meant the
// command ran on TWO credentials at once, and they collide:
//
//   wrangler prefers CLOUDFLARE_API_TOKEN over its stored OAuth session.
//
// So the broad setup token, which the command takes for its API calls and passes
// to every child process it spawns, SILENTLY REPLACED the login those steps were
// documented to use. The README said the secret steps "need no API permission at
// all"; in practice they failed with `Authentication error` against
// /accounts/{id}/workers/scripts/{name}/secrets, because the setup token had no
// Workers permission and was the one being used. Measured on a real run,
// 2026-09-07.
//
// The fix is not to hide the token from the child. It is to stop needing two
// credentials: everything here is a plain REST call the setup token can make, so
// there is exactly one thing to authorize and one place to look when it is
// refused. `wrangler deploy` is the only shell-out left, and it uses the same
// token rather than a different one.
//
// SHAPES, LOOKED UP. Both endpoints are in the API reference under
// workers/scripts/secrets:
//
//   GET /accounts/{account_id}/workers/scripts/{script_name}/secrets
//   PUT /accounts/{account_id}/workers/scripts/{script_name}/secrets
//
// The list answers `SecretText` objects — `{name, text, type}` — which is also
// what `wrangler secret list --format json` prints, and is the same triple the
// bulk-secrets endpoint documents for a write. The reference does not spell out
// the PUT body on its own page; the per-secret object comes from the bulk
// endpoint's own worked example, `{"type": "secret_text", "name": "API_KEY",
// "text": "my-api-key"}`, corroborated by the list response model above. Two
// independent statements of the same triple, rather than one recollection.

import { type ApiResult, type CloudflareOptions, call } from "../cloudflare.ts";

export type Account = { id: string; name: string };

const readAccount = (value: unknown): Account | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const id = Reflect.get(value, "id");
  const name = Reflect.get(value, "name");
  return typeof id === "string" && typeof name === "string" ? { id, name } : undefined;
};

/**
 * Which account this token belongs to.
 *
 * Replaces `wrangler whoami`, and is strictly better at the job: the answer
 * describes the credential setup is actually going to use, not whichever login
 * happens to be on the machine. Those were allowed to disagree before, and when
 * they did, every verdict in the report was about the wrong account.
 *
 * More than one is an error rather than a guess. A token that can see two
 * accounts gives setup no way to know which one holds the Worker, and picking
 * the first would configure a stranger's zone as readily as your own.
 */
export async function resolveAccount(cf: CloudflareOptions): Promise<ApiResult<Account>> {
  const res = await call<unknown>(cf, "GET", "/accounts");
  if (!res.ok) return res;
  const accounts = (Array.isArray(res.result) ? res.result : [])
    .map(readAccount)
    .filter((a): a is Account => a !== undefined);

  const only = accounts[0];
  if (!only) {
    return {
      ok: false,
      error:
        "this token can see no accounts — check that CLOUDFLARE_API_TOKEN is an account-owned token for the account holding the Worker",
    };
  }
  if (accounts.length > 1) {
    return {
      ok: false,
      error: `this token can see ${accounts.length} accounts (${accounts
        .map((a) => `${a.name} (${a.id})`)
        .join(
          ", "
        )}) — scope it to the one holding the Worker, so setup cannot configure the wrong zone`,
    };
  }
  return { ok: true, result: only };
}

const secretsPath = (accountId: string, script: string) =>
  `/accounts/${accountId}/workers/scripts/${encodeURIComponent(script)}/secrets`;

/**
 * The names of the Worker's secrets. Names only — the value of a secret is never
 * readable back, which is exactly the property that makes this check safe to run
 * and safe to log.
 *
 * Used to decide whether a credential already exists. That question has to be
 * answered before generating one, because overwriting `CDN_UPLOAD_TOKEN` would
 * silently break every writer already using it: the hooks, the CLI on another
 * machine, the Shortcut. Setup can create a missing credential; it must never
 * replace a working one.
 */
export async function secretNames(
  cf: CloudflareOptions,
  accountId: string,
  script: string
): Promise<ApiResult<string[]>> {
  const res = await call<unknown>(cf, "GET", secretsPath(accountId, script));
  if (!res.ok) return res;
  const names = (Array.isArray(res.result) ? res.result : [])
    .map((entry) => Reflect.get(Object(entry), "name"))
    .filter((name): name is string => typeof name === "string");
  return { ok: true, result: names };
}

/**
 * Set one secret on the Worker.
 *
 * The value goes in a request body and nowhere else: not a process argument, not
 * a shell history, not a log line. That was already true of the `wrangler secret
 * put` this replaces — it took the value on stdin for the same reason — and it
 * stays true here.
 *
 * On a `--dry-run` this never reaches Cloudflare: `readOnlyFetch` intercepts
 * every non-GET. Note that the callers do not rely on that alone — each one
 * checks `dryRun` before it so much as GENERATES a credential, so a dry run has
 * no secret to leak in the first place.
 */
export async function putSecret(
  cf: CloudflareOptions,
  accountId: string,
  script: string,
  name: string,
  text: string
): Promise<ApiResult<unknown>> {
  return call<unknown>(cf, "PUT", secretsPath(accountId, script), {
    name,
    text,
    type: "secret_text",
  });
}
