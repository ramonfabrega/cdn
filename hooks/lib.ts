// Shared plumbing for the CDN mirror hooks (artifact-mirror, user-file-mirror).
//
// Both do the same two things — put a file on the CDN, then hand the URL back
// through the PostToolUse contract — so the plumbing lives here once instead of
// drifting between two copies.
//
// This used to shell out to a `share` CLI and patch PATH so that CLI could find
// Homebrew, so it could find a password manager, so it could find the upload
// token. Every link in that chain existed to answer "where is the token", which
// hosts.ts now answers directly. What is left is one POST: the upload API is a
// bearer and a body, and `fetch` is already in the runtime.

import { resolveTarget, type Target } from "./hosts.ts";

export type { Target };
export { resolveTarget };

/** PostToolUse contract: additionalContext lands in the model's context, systemMessage
    on the user's screen. Both, so the URL survives even if the model forgets to relay it. */
export const emit = (context: string, forUser?: string): never => {
  console.log(
    JSON.stringify({
      ...(forUser ? { systemMessage: forUser } : {}),
      hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: context },
    })
  );
  process.exit(0);
};

/** A short hash of the absolute path: stable across re-sends of the SAME file (so a
    second send overwrites instead of piling up copies) while two different files that
    happen to share a basename never clobber each other. */
export const slugFor = (path: string, fallback: string) => {
  const stem = (path.split("/").pop() ?? fallback).replace(/\.[^.]+$/, "");
  const clean = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${clean || fallback}-${Bun.hash(path).toString(16).slice(0, 6)}`;
};

/** https everywhere except a loopback host, which is `wrangler dev` — the one
    address that legitimately has no certificate. Also what makes these hooks
    testable end-to-end against a stub server instead of a mocked fetch. */
export const originFor = (host: string) =>
  /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host) ? `http://${host}` : `https://${host}`;

/** Upload one file under `key`. Returns the public URL the Worker minted, or an
    error string — never throws, because both callers must exit 0 whatever happens. */
export async function upload(
  target: Target,
  src: string,
  key: string,
  timeoutMs: number
): Promise<{ url?: string; error?: string }> {
  // The Worker chooses nothing about the key and everything about the content
  // type (it derives it from the extension), so the client's whole job is to
  // name the key and stream the bytes. Bun.file streams and sets content-length,
  // so a large recording never buffers in memory here.
  const endpoint = `${originFor(target.host)}/api/upload?key=${encodeURIComponent(key)}`;
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}` },
      body: Bun.file(src),
      // Without this a hung connection is killed by the hook's own timeout, which
      // looks to the transcript like the hook never ran. A legible skip beats a
      // silent one — same reason user-file-mirror caps file size.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    return { error: `${target.host} unreachable: ${why}` };
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).trim().slice(0, 200);
    // 401 is the one worth spelling out: it is always the token, and the fix is
    // a file this process can name.
    const hint = res.status === 401 ? " — check CDN_TOKEN for this host" : "";
    return {
      error: `${target.host} rejected the upload (${res.status})${hint}${detail ? `: ${detail}` : ""}`,
    };
  }

  // Trust the Worker's own url over one built here: it is minted from the request
  // it answered, so it is right on a custom domain, a preview and wrangler dev
  // alike, and it stays right if key encoding ever changes on that side.
  const body: unknown = await res.json().catch(() => null);
  const url =
    typeof body === "object" && body !== null && "url" in body && typeof body.url === "string"
      ? body.url
      : undefined;
  return url ? { url } : { error: `${target.host} accepted the upload but returned no url` };
}
