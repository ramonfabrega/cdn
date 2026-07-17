// Public folder share page — what a folder URL (…/golf-sim/sfx-family/) renders.
// Read-only and unauthenticated by design: the objects under a prefix are already
// public, this just makes the "natural" folder link resolve to a listing of them
// instead of a 404. Rendered server-side with hono/jsx (auto-escaped); shares the
// explorer's OKLCH palette via lib/ui.ts; zero client JS.

import type { FC } from "hono/jsx";

import { publicUrl } from "./lib/cdn.ts";
import { BADGE, BASE_TOKENS, fmtDate, fmtSize, href } from "./lib/ui.ts";
import type { Entry } from "./storage.ts";

const CSS = `
  :root{
    ${BASE_TOKENS}
    --well:light-dark(oklch(96% .006 265),oklch(17.5% .009 265));
    --hover:light-dark(oklch(94% .009 265),oklch(22% .012 265));
    --on-bright:oklch(20% .01 265);
    --mono:ui-monospace,"SF Mono",Menlo,monospace;
    --sans:system-ui,-apple-system,sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{background:var(--bg);color:var(--ink);font:14px/1.5 var(--sans);
    -webkit-font-smoothing:antialiased;font-variant-numeric:tabular-nums;
    min-height:100dvh;display:flex;flex-direction:column;align-items:center;
    padding:clamp(16px,4vw,44px) clamp(10px,3vw,24px)}
  .wrap{width:min(860px,100%)}
  .top{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;padding:0 4px 12px}
  .crumbs{font:15px var(--mono);color:var(--dim);word-break:break-all}
  .crumbs a{color:var(--dim);text-decoration:none}
  .crumbs a:hover{color:var(--ink);text-decoration:underline}
  .crumbs b{color:var(--ink);font-weight:600}
  .crumbs .sep{color:var(--faint);padding:0 5px}
  .meta{margin-left:auto;font:12px var(--mono);color:var(--faint);white-space:nowrap}
  .card{background:var(--card);border:1px solid var(--line2);border-radius:12px;
    box-shadow:0 10px 32px var(--shadow);overflow:hidden}
  .row{display:grid;grid-template-columns:1fr 58px 78px 96px;align-items:center;gap:12px;
    padding:0 16px;height:44px;border-top:1px solid var(--line);
    color:inherit;text-decoration:none;font:13px var(--mono)}
  .row:first-child{border-top:0}
  .row:hover{background:var(--hover)}
  .nm{display:flex;align-items:center;gap:9px;min-width:0;overflow:hidden;
    text-overflow:ellipsis;white-space:nowrap}
  .nm svg{flex:none;color:var(--dim)}
  .up .nm{color:var(--faint)}
  .badge{font:600 10px/1 var(--sans);letter-spacing:.04em;text-transform:uppercase;
    text-align:center;padding:4px 6px;border-radius:5px;color:var(--on-bright)}
  .dirb{background:none;border:1px solid var(--line2);color:var(--faint)}
  .sz{font-size:12px;color:var(--dim);text-align:right}
  .dt{font-size:12px;color:var(--dim);text-align:right}
  .empty{padding:44px 16px;text-align:center;color:var(--faint);font-size:13px}
  footer{padding:16px 4px;font:11px var(--mono);color:var(--faint)}
  footer b{color:var(--dim);font-weight:600}
  @media (max-width:560px){
    .row{grid-template-columns:1fr 52px 70px;gap:8px}
    .dt{display:none}
  }`;

const FolderIco: FC = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
  </svg>
);

/** Breadcrumb: each ancestor segment links to its own folder page; the root
    crumb is plain text ("/" is the gated explorer — don't send guests to a login). */
const Crumbs: FC<{ prefix: string }> = ({ prefix }) => {
  const parts = prefix.replace(/\/$/, "").split("/");
  let acc = "";
  return (
    <>
      {parts.map((p, i) => {
        acc += `${p}/`;
        return (
          <>
            {i > 0 && <span class="sep">/</span>}
            {i === parts.length - 1 ? <b>{p}</b> : <a href={href(acc)}>{p}</a>}
          </>
        );
      })}
    </>
  );
};

// Child folders link to their ABSOLUTE url; the `..` parent stays relative. An
// agent handed this page via an HTML→markdown fetch keeps a link's target exactly
// as written — a root-relative `/foo/` gives it a path it won't turn into a URL,
// so contents (down) publish full urls while upward nav (toward the roots) doesn't.
const DirRow: FC<{ origin: string; to: string; label?: string; up?: boolean }> = ({
  origin,
  to,
  label,
  up,
}) => (
  <a class={up ? "row up" : "row"} href={up ? href(to) : publicUrl(origin, to)}>
    <span class="nm">
      {up ? (
        ".."
      ) : (
        <>
          <FolderIco />
          {label}/
        </>
      )}
    </span>
    <span class="badge dirb">dir</span>
    <span class="sz"></span>
    <span class="dt"></span>
  </a>
);

// f.url is the absolute publicUrl(key) (see storage.ts). Absolute so it survives
// an HTML→markdown fetch as a real URL — the whole point of the folder page for a
// machine reader: read once, then fetch each file directly, no second hop.
const FileRow: FC<{ f: Entry; prefix: string }> = ({ f, prefix }) => (
  <a class="row" href={f.url}>
    <span class="nm">{f.key.slice(prefix.length)}</span>
    <span class="badge" style={`background:${BADGE[f.category] ?? BADGE.file}`}>
      {f.ext || "file"}
    </span>
    <span class="sz">{fmtSize(f.size)}</span>
    <span class="dt">{fmtDate(f.lastModified)}</span>
  </a>
);

const Page: FC<{ origin: string; prefix: string; files: Entry[]; folders: string[] }> = ({
  origin,
  prefix,
  files,
  folders,
}) => {
  const name = prefix.replace(/\/$/, "").split("/").pop() ?? prefix;
  const total = files.reduce((n, f) => n + f.size, 0);
  const sorted = [...files].sort((a, b) =>
    a.key.localeCompare(b.key, undefined, { numeric: true })
  );
  const parent = prefix.replace(/[^/]+\/$/, "");
  const items = folders.length + sorted.length;
  const meta = `${items} item${items === 1 ? "" : "s"}${total ? ` · ${fmtSize(total)}` : ""}`;

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{name} · cdn</title>
        {/* unfurl card — /.og/<prefix>.png (see src/card.ts). Absolute URLs, as
            scrapers require — on the REQUEST origin, not a canonical domain: the
            Worker answers on several hosts (custom domain, preview builds, dev),
            and a scraper unfurling a preview link must card the preview. */}
        <meta property="og:title" content={`${name}/`} />
        <meta property="og:description" content={meta} />
        <meta property="og:type" content="website" />
        <meta property="og:url" content={publicUrl(origin, prefix)} />
        <meta
          property="og:image"
          content={`${publicUrl(origin, `.og/${prefix.replace(/\/$/, "")}`)}.png`}
        />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="630" />
        <meta name="twitter:card" content="summary_large_image" />
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <div class="wrap">
          <div class="top">
            <span class="crumbs">
              <Crumbs prefix={prefix} />
              <span class="sep">/</span>
            </span>
            <span class="meta">{meta}</span>
          </div>
          <div class="card">
            {!parent && items === 0 ? (
              <div class="empty">Empty folder.</div>
            ) : (
              <>
                {parent && <DirRow origin={origin} to={parent} up />}
                {folders.map((f) => (
                  <DirRow
                    origin={origin}
                    to={f}
                    label={f.slice(prefix.length).replace(/\/$/, "")}
                  />
                ))}
                {sorted.map((f) => (
                  <FileRow f={f} prefix={prefix} />
                ))}
              </>
            )}
          </div>
          <footer>
            <b>cdn</b>.ramonfabrega.com
          </footer>
        </div>
      </body>
    </html>
  );
};

export const folderPage = (
  origin: string,
  prefix: string,
  files: Entry[],
  folders: string[]
): string =>
  `<!doctype html>${<Page origin={origin} prefix={prefix} files={files} folders={folders} />}`;
