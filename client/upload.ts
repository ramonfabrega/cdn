// The write path, client side. `POST /api/upload` is one bearer and a body, so
// this is the whole of it — shared by the CLI (`cdn up`), the two Claude Code
// hooks, and, in prose rather than code, `macos/quickshare`, which speaks the
// same three lines in curl because a Mac has curl and might not have Bun.
//
// Nothing here composes a public URL. The Worker answers with the one it minted
// from the request it served, which is right on a custom domain, a preview and
// `wrangler dev` alike — so a client that built its own would be asserting
// something only the server knows.

import type { Target } from "./hosts.ts";

/** https everywhere except a loopback host, which is `wrangler dev` — the one
    address that legitimately has no certificate. Also what lets the hook and CLI
    tests run end-to-end against a stub server instead of a mocked fetch. */
export const originFor = (host: string) =>
  /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? `http://${host}` : `https://${host}`;

export type Uploaded = { url: string; key: string; permanent: boolean };
export type UploadResult = { ok: true; uploaded: Uploaded } | { ok: false; error: string };

export type UploadOptions = {
  /** Exempt the object from the Worker's 30-day expiry sweep. Omitted rather than
      sent as `0`, because an absent param means "keep whatever the key already
      had" — a release script that forgets the flag must not silently re-arm the
      sweep on a key someone marked permanent. */
  permanent?: boolean;
  /** Abort rather than hang. Callers pass their own ceiling: a hook has the
      harness's timeout, the CLI has a person's patience. */
  timeoutMs?: number;
  /** The test seam. Swapped for a recorder in tests; production passes nothing. */
  fetch?: typeof globalThis.fetch;
};

/** Upload one file under `key`. Returns a value, never throws: every caller here
    has a reason not to let a failed upload become an exception — a hook must not
    fail the tool it followed, and the CLI turns it into an error envelope with a
    CTA rather than a stack trace. */
export async function upload(
  target: Target,
  src: string,
  key: string,
  options: UploadOptions = {}
): Promise<UploadResult> {
  const { permanent, timeoutMs = 120_000, fetch: doFetch = globalThis.fetch } = options;
  const query = new URLSearchParams({ key });
  if (permanent) query.set("permanent", "1");
  const endpoint = `${originFor(target.host)}/api/upload?${query}`;

  let res: Response;
  try {
    res = await doFetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}` },
      // Bun.file streams and sets content-length, so a screen recording never
      // buffers in memory on the way out.
      body: Bun.file(src),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return {
      ok: false,
      error: `${target.host} unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
    return { ok: false, error: describeFailure(target.host, res.status, detail) };
  }

  const body: unknown = await res.json().catch(() => null);
  const uploaded = readUploaded(body);
  return uploaded
    ? { ok: true, uploaded }
    : { ok: false, error: `${target.host} accepted the upload but returned no url` };
}

/** Verify a bearer without writing anything. `auth login` needs this: the only
    other way to find out whether a token works is to upload a file with it,
    which is a side effect nobody asked for while logging in. */
export async function verify(
  target: Target,
  options: Pick<UploadOptions, "timeoutMs" | "fetch"> = {}
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { timeoutMs = 15_000, fetch: doFetch = globalThis.fetch } = options;
  let res: Response;
  try {
    res = await doFetch(`${originFor(target.host)}/api/auth`, {
      headers: { authorization: `Bearer ${target.token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    return {
      ok: false,
      error: `${target.host} unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  return res.ok ? { ok: true } : { ok: false, error: describeFailure(target.host, res.status, "") };
}

// 401 is worth spelling out because it is always the token and the fix is a file
// we can name. 404 is worth spelling out because it means the host answered but
// isn't this Worker — a typo'd domain, or a zone that hasn't finished pointing at
// it, which reads like an auth problem if you only see a status code.
const describeFailure = (host: string, status: number, detail: string) => {
  const hint =
    status === 401
      ? ` — the token was rejected; check CDN_TOKEN or run \`cdn auth login --host ${host}\``
      : status === 404
        ? " — that host answered, but it is not a cdn Worker"
        : "";
  return `${host} rejected the request (${status})${hint}${detail ? `: ${detail}` : ""}`;
};

/** Parse the Worker's answer at the boundary rather than trusting its shape.
    Reflect + typeof rather than zod: this module is on the hooks' hot path, and
    they should not pay a schema library's import to read three fields. zod lives
    at the CLI's edges, where incur already brings it. */
const readUploaded = (body: unknown): Uploaded | undefined => {
  if (typeof body !== "object" || body === null) return undefined;
  const url: unknown = Reflect.get(body, "url");
  const key: unknown = Reflect.get(body, "key");
  const permanent: unknown = Reflect.get(body, "permanent");
  if (typeof url !== "string" || typeof key !== "string") return undefined;
  return { url, key, permanent: permanent === true };
};
