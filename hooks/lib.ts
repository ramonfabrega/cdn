// What the two mirror hooks share that is theirs alone: the PostToolUse contract
// and the key-naming rule. Everything about talking to the CDN — finding a host,
// finding a token, doing the POST — lives in `client/`, because the CLI and the
// hooks are two projections of the same three lines and only one of them should
// own them.

import { resolveTarget, type Target } from "../client/hosts.ts";
import { originFor, upload as put } from "../client/upload.ts";

export type { Target };
export { originFor, resolveTarget };

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
    happen to share a basename never clobber each other.

    This is the hooks' rule, not the CLI's. `cdn up` mints a random slug because a
    person naming a file wants a fresh link; a hook re-mirroring the same artifact
    wants the same one. */
export const slugFor = (path: string, fallback: string) => {
  const stem = (path.split("/").pop() ?? fallback).replace(/\.[^.]+$/, "");
  const clean = stem
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${clean || fallback}-${Bun.hash(path).toString(16).slice(0, 6)}`;
};

/** The hooks' shape over `client/upload`: flat `{url}`/`{error}` rather than a
    tagged union, because every call site here immediately turns one into a line
    of transcript and the other into a different line of transcript. */
export async function upload(
  target: Target,
  src: string,
  key: string,
  timeoutMs: number
): Promise<{ url?: string; error?: string }> {
  const res = await put(target, src, key, { timeoutMs });
  return res.ok ? { url: res.uploaded.url } : { error: res.error };
}
