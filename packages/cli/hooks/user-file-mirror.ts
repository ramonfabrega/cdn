#!/usr/bin/env bun
// PostToolUse(SendUserFile) — mirror every file Claude attaches to your CDN.
//
// The file cards Claude sends (`› [image] ~/.claude/jobs/…/shot.png`) are LOCAL paths.
// That's fine at the machine they were written on — cmd-click, or the desktop app — and
// useless from a phone or an ssh session, which is where half of these conversations
// happen. Worse, the usual source is a job's tmp dir, which dies with the job.
//
// So: every send also lands on your CDN and the hook prints the URL. The card stays
// the fast local path; the link is the one that travels.
//
// Sibling of artifact-mirror.ts (same idea, different tool). Which host is config,
// not code: `CDN_HOST` in the settings `env` for whatever scope should mirror where.
// See the README.
//
// Never fails the tool: any error exits 0 with a note in additionalContext. A mirror
// that didn't happen is worth a line in the transcript, not a broken send.

import { extname, isAbsolute, resolve } from "node:path";

import { emit, resolveTarget, slugFor, upload } from "./lib.ts";

const NAMESPACE = "sent/";
// Screenshots and reports upload in well under a second; a screen recording might not.
// The hook's own timeout is the real ceiling — this just turns "silently truncated by
// the harness" into a legible skip.
const MAX_BYTES = 100 * 1024 * 1024;
// Under the hook's own 120s timeout in the README's snippet, for the same reason.
const TIMEOUT_MS = 110_000;

const payload = await new Response(Bun.stdin.stream()).json().catch(() => null);
const files: string[] = payload?.tool_input?.files ?? [];
if (!files.length) process.exit(0);
// PostToolUse only fires on success, so every path here was accepted by the tool.

const resolved = await resolveTarget();
if (!resolved.ok) emit(`CDN mirror skipped: ${resolved.error}`);

// SendUserFile takes paths absolute or relative to the session's cwd; the hook runs
// with its own working directory, so resolve against the cwd the payload reports.
const cwd: string = payload?.cwd ?? process.cwd();
const abs = (p: string) => (isAbsolute(p) ? p : resolve(cwd, p));

const results = await Promise.all(
  files.map(async (path) => {
    const src = abs(path);
    const size = Bun.file(src).size;
    if (!size) return { path, error: "unreadable or empty" };
    if (size > MAX_BYTES)
      return { path, error: `${(size / 1024 ** 2).toFixed(0)} MB — too big to mirror` };
    const key = `${NAMESPACE}${slugFor(src, "file")}${extname(src)}`;
    return { path, ...(await upload(resolved.target, src, key, TIMEOUT_MS)) };
  })
);

const ok = results.filter((r) => r.url);
const failed = results.filter((r) => r.error);

if (!ok.length) {
  emit(`CDN mirror failed: ${failed.map((f) => `${f.path} (${f.error})`).join("; ")}`);
}

const lines = ok.map((r) => r.url).join("\n");
emit(
  `Mirrored to ${resolved.target.host} — hand these links to the user alongside the file cards, ` +
    `they're what works from a phone or an ssh session (the cards are local paths):\n${lines}` +
    (failed.length
      ? `\nNot mirrored: ${failed.map((f) => `${f.path} (${f.error})`).join("; ")}`
      : "") +
    `\nCopies expire in 30 days unless flagged permanent in the explorer.`,
  ok.length === 1 ? `Mirrored to ${ok[0]?.url}` : `Mirrored ${ok.length} files:\n${lines}`
);
