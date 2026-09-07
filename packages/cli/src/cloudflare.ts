// The Cloudflare API, behind one door.
//
// Nothing in phase 4 calls this. It exists because phase 5 is `cdn setup` — the
// post-button checklist done from code: the custom-domain route, the Zero Trust
// application and its bypass on /api/upload, Browser Cache TTL, and minting the
// narrow purge token — and every one of those is the same three lines with a
// different path. Writing the three lines once, now, means that phase adds calls
// rather than plumbing.
//
// Three things are worth getting right before there is anything to get wrong:
//
// THE ENVELOPE. Cloudflare answers `{success, errors, messages, result}` and uses
// HTTP status inconsistently — a 200 with `success: false` is a real answer shape.
// So the status is not the check; `success` is, and the errors are unpacked into
// a message a person can act on rather than `[object Object]`.
//
// THE SEAM. `fetch` is injectable, so a call is testable without a network and
// without a Cloudflare account. That is not only for tests: `cdn setup --dry-run`
// has to be able to say what it WOULD do, and a client that can be handed a
// recorder is a client that can be handed a dry-run recorder.
//
// THE TOKEN. One broad setup token, used once, never written to disk. It is not
// the purge token — that one is narrow, account-owned and minted BY setup — and
// conflating them is how a Worker ends up holding a credential that can
// reconfigure the zone.

export type CloudflareOptions = {
  /** The API token. Passed per-call rather than stored: `cdn setup` takes one
      broad token for one run and should not leave it anywhere. */
  token: string;
  /** Injected in tests and by `--dry-run`. Production passes nothing. */
  fetch?: typeof globalThis.fetch;
  /** Cloudflare's API root. Only a test or a proxy has a reason to change it. */
  base?: string;
  timeoutMs?: number;
};

export type ApiResult<T> = { ok: true; result: T } | { ok: false; error: string; status?: number };

const API = "https://api.cloudflare.com/client/v4";

/** One request. `path` is relative to the API root and starts with a slash. */
export async function call<T = unknown>(
  options: CloudflareOptions,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown
): Promise<ApiResult<T>> {
  const { token, fetch: doFetch = globalThis.fetch, base = API, timeoutMs = 30_000 } = options;

  let res: Response;
  try {
    res = await doFetch(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return { ok: false, error: `cloudflare api unreachable: ${asMessage(e)}` };
  }

  const payload: unknown = await res.json().catch(() => null);

  // `success` is the answer, not the status code: Cloudflare returns 200 with
  // `success: false` often enough that trusting the status silently accepts
  // failures.
  const success = read(payload, "success");
  if (success === true) return { ok: true, result: read(payload, "result") as T };

  const errors = describeErrors(read(payload, "errors"));
  const hint =
    res.status === 403
      ? " — the token lacks the permission for this call"
      : res.status === 404
        ? " — no such resource, or the token cannot see it"
        : "";
  return {
    ok: false,
    status: res.status,
    error: `${method} ${path} failed (${res.status})${hint}${errors ? `: ${errors}` : ""}`,
  };
}

/** Cloudflare's errors are `{code, message}` objects; unpack them into something
    a person can act on rather than `[object Object]`. */
const describeErrors = (errors: unknown): string => {
  if (!Array.isArray(errors)) return "";
  return errors
    .map((e) => {
      const message = read(e, "message");
      const code = read(e, "code");
      return typeof message === "string"
        ? typeof code === "number"
          ? `${message} (${code})`
          : message
        : JSON.stringify(e);
    })
    .join("; ");
};

const read = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const asMessage = (e: unknown) => (e instanceof Error ? e.message : String(e));
