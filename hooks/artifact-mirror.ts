#!/usr/bin/env bun
// PostToolUse(Artifact) — mirror a published artifact to your CDN.
//
// The Artifact tool publishes to claude.ai and that destination isn't configurable,
// so this is a MIRROR, not a redirect: the claude.ai URL stays the interactive one
// (comments, version history, runtime capabilities), and this adds a copy on your
// own host — in your explorer next to everything else, viewable by people without
// a Claude account.
//
// Which host is config, not code: `CDN_HOST` in the settings `env` for whatever
// scope should mirror where. See the README; installation is a settings.json
// snippet plus one token file.
//
// The skeleton is the whole reason this isn't a one-line upload. Artifact HTML
// is authored WITHOUT <!doctype>/<html>/<head>/<body> — the publisher wraps it at
// publish time with a charset + viewport meta and a small reset. Upload that file raw
// and you get a headless fragment: no viewport meta (the phone case), no reset. So we
// reproduce the wrapper here, hoisting the page's own <title> into the head.
//
// Never fails the tool: any error exits 0 with a note in additionalContext. A mirror
// that didn't happen is worth a line in the transcript, not a broken publish.

import { emit, resolveTarget, slugFor, upload } from "./lib.ts";

const NAMESPACE = "artifacts/";
// Under the hook's own 30s timeout in the README's snippet, so a stalled upload
// reports itself instead of being killed mid-flight.
const TIMEOUT_MS = 25_000;

// The publisher's own skeleton, reproduced. Kept in sync by hand — if an artifact
// renders differently here than on claude.ai, this string is the first suspect.
const wrap = (title: string, body: string) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
:root { color-scheme: light }
body { margin: 0; font: 14px system-ui, -apple-system, "Segoe UI", sans-serif; background: #fafaf9 }
img { max-width: 100% }
[hidden] { display: none !important }
</style>
</head>
<body>
${body}
</body>
</html>
`;

const payload = await new Response(Bun.stdin.stream()).json().catch(() => null);
const input = payload?.tool_input ?? {};

// Only publishes carry a file. Every other action (list/read/comments/reply/watch/…)
// addresses an artifact by url and has nothing local to mirror.
const action = input.action ?? "publish";
const src: string | undefined = input.file_path;
if (action !== "publish" || !src) process.exit(0);
// PostToolUse only fires on success — a failed publish goes to PostToolUseFailure —
// so reaching here means the artifact is live and worth mirroring.

const resolved = await resolveTarget();
if (!resolved.ok) emit(`CDN mirror skipped: ${resolved.error}`);

const raw = await Bun.file(src)
  .text()
  .catch(() => null);
if (raw === null) emit(`CDN mirror skipped: could not read ${src}.`);

const base = src.split("/").pop() ?? "artifact.html";
const stem = base.replace(/\.[^.]+$/, "");
const slug = slugFor(src, "artifact");

let source = src;
let cleanup: string | null = null;

if (base.endsWith(".html")) {
  // A file that already declares itself a document was written for somewhere else and
  // is complete as-is; only the head-less artifact shape needs the skeleton.
  const complete = /^\s*<(!doctype|html)\b/i.test(raw);
  if (!complete) {
    // The publisher scans the first 8KB for a <title>; match that so the mirror is
    // titled the same as the artifact.
    const title = raw
      .slice(0, 8192)
      .match(/<title>([\s\S]*?)<\/title>/i)?.[1]
      ?.trim();
    source = `${process.env.TMPDIR ?? "/tmp"}/artifact-mirror-${slug}.html`;
    cleanup = source;
    await Bun.write(source, wrap(title || stem, raw));
  }
}

const key = `${NAMESPACE}${slug}${base.endsWith(".md") ? ".md" : ".html"}`;
const { url, error } = await upload(resolved.target, source, key, TIMEOUT_MS);
if (cleanup)
  await Bun.file(cleanup)
    .delete()
    .catch(() => {});

if (error) emit(`CDN mirror failed (${error})`);

emit(
  `Mirrored to ${resolved.target.host}: ${url} — a static copy on that host, ` +
    `expiring in 30 days unless flagged permanent in the explorer. Surface it alongside ` +
    `the artifact URL; note that runtime capabilities and comments exist only on the artifact.`,
  `Mirrored to ${url}`
);
