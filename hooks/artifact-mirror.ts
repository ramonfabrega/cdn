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
// reproduce the wrapper here, hoisting the page's own <title> into the head — and,
// since we're building a <head> anyway, adding the unfurl meta a shared link wants
// and an artifact page has no use for.
//
// Never fails the tool: any error exits 0 with a note in additionalContext. A mirror
// that didn't happen is worth a line in the transcript, not a broken publish.

import { emit, originFor, resolveTarget, slugFor, upload } from "./lib.ts";

const NAMESPACE = "artifacts/";
// Under the hook's own 30s timeout in the README's snippet, so a stalled upload
// reports itself instead of being killed mid-flight.
const TIMEOUT_MS = 25_000;

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ENTITIES[c] ?? c);

// The publisher's own skeleton, reproduced, plus the unfurl meta a mirror needs and
// an artifact page does not. Kept in sync by hand — if an artifact renders
// differently here than on claude.ai, this string is the first suspect.
//
// No og:image, deliberately. A generic card would say nothing the title doesn't,
// and a real thumbnail means rendering the page — Cloudflare Browser Rendering, a
// new binding and the only heavyweight dependency anywhere in this project. The
// text unfurl is the whole of the cheap win: a pasted mirror link stops reading as
// a bare URL.
//
// noindex matches the folder pages: a mirror is a public URL on your domain, but
// publishing it is your decision to make by sharing the link, not a crawler's.
const wrap = ({
  title,
  description,
  url,
  body,
}: {
  title: string;
  description: string;
  url: string;
  body: string;
}) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:url" content="${esc(url)}">
<meta name="twitter:card" content="summary">
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

const TITLE_TAG = /<title>([\s\S]*?)<\/title>/i;

/** First heading's text, as the unfurl's one line of description. Falls back to the
    title — a card that repeats itself still beats one with an empty line in it. */
const describe = (html: string, fallback: string) => {
  const heading = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const text = heading
    ?.replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text || fallback;
};

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

const key = `${NAMESPACE}${slug}${base.endsWith(".md") ? ".md" : ".html"}`;

// The one URL in this repo composed rather than read back off a response, because
// og:url has to be INSIDE the bytes being uploaded. It is built from the same
// resolved host the POST uses and the key about to be written, so it cannot name
// somewhere the file isn't — and what gets reported to the session is still the
// Worker's own answer.
const mirrorUrl = `${originFor(resolved.target.host)}/${key
  .split("/")
  .map(encodeURIComponent)
  .join("/")}`;

let source = src;
let cleanup: string | null = null;

if (base.endsWith(".html")) {
  // A file that already declares itself a document was written for somewhere else and
  // is complete as-is; only the head-less artifact shape needs the skeleton.
  const complete = /^\s*<(!doctype|html)\b/i.test(raw);
  if (!complete) {
    // The publisher scans the first 8KB for a <title>; match that so the mirror is
    // titled the same as the artifact.
    const found = raw.slice(0, 8192).match(TITLE_TAG);
    const title = found?.[1]?.trim();
    // Hoisting means MOVING it. Leaving the tag where it was puts <title> in the
    // document twice — browsers take the first and render correctly, but a scraper
    // reading the second gets a different answer than the tab does.
    const body = found ? raw.replace(TITLE_TAG, "") : raw;
    source = `${process.env.TMPDIR ?? "/tmp"}/artifact-mirror-${slug}.html`;
    cleanup = source;
    await Bun.write(
      source,
      wrap({
        title: title || stem,
        description: describe(body, title || stem),
        url: mirrorUrl,
        body,
      })
    );
  }
}

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
