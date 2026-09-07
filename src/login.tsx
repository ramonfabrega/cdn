// Sign-in page for the gated explorer (/ and /api/*). Rendered server-side with
// hono/jsx; shares the explorer's OKLCH palette via lib/ui.ts.

import type { FC } from "hono/jsx";

import { BASE_TOKENS, brand } from "./lib/ui.ts";

const CSS = `
  :root{
    ${BASE_TOKENS}
    --accent:oklch(58% .19 265);
    --on-accent:oklch(100% 0 0);
    --red:oklch(62% .2 20);
  }
  *{box-sizing:border-box}
  body{margin:0;min-height:100dvh;display:grid;place-items:center;
    font:15px/1.5 ui-sans-serif,system-ui,-apple-system,sans-serif;
    background:var(--bg);color:var(--ink)}
  form{width:min(92vw,320px);display:flex;flex-direction:column;gap:14px;
    padding:28px;border:1px solid var(--line2);border-radius:16px;
    background:var(--card);box-shadow:0 16px 48px var(--shadow)}
  h1{margin:0;font-size:15px;letter-spacing:.04em;color:var(--dim);font-weight:600}
  h1 b{color:var(--ink);font-weight:600}
  input{padding:11px 13px;border:1px solid var(--line);border-radius:10px;
    background:var(--bg);color:var(--ink);font-size:15px;outline:none}
  input::placeholder{color:var(--faint)}
  input:focus{border-color:var(--accent)}
  button{padding:11px;border:0;border-radius:10px;background:var(--accent);
    color:var(--on-accent);font-size:15px;font-weight:600;cursor:pointer;
    transition:filter .15s}
  button:hover{filter:brightness(1.08)}
  .err{color:var(--red);font-size:13px;margin:0}
  .setup{width:min(92vw,420px);padding:28px;border:1px solid var(--line2);
    border-radius:16px;background:var(--card);box-shadow:0 16px 48px var(--shadow)}
  .setup p{margin:14px 0 0;font-size:13px;color:var(--dim)}
  .setup code{display:block;margin-top:10px;padding:10px 12px;border-radius:8px;
    background:var(--bg);border:1px solid var(--line);color:var(--ink);
    font:12px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;
    overflow-x:auto;white-space:pre}`;

const Login: FC<{ host: string; error?: string }> = ({ host, error }) => {
  const { name, rest } = brand(host);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{name} · sign in</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <form method="post" action="/login">
          <h1>
            🔒 <b>{name}</b>
            {rest}
          </h1>
          {error && <p class="err">{error}</p>}
          <input type="password" name="password" placeholder="password" autofocus required />
          <button type="submit">Enter</button>
        </form>
      </body>
    </html>
  );
};

/**
 * What an unconfigured instance shows instead of a password box.
 *
 * With no `CDN_PASSWORD` there is no password that can ever be right, so the
 * form would reject every attempt with "Wrong password." — which is a lie about
 * what is wrong, and the kind of lie somebody debugs for twenty minutes. This
 * says the true thing and gives the one command that fixes it.
 *
 * Deliberately NOT a security boundary: it discloses only that the instance is
 * fresh, which an empty bucket and a login that refuses everything already say.
 * The boundary is that the gate cannot be passed at all in this state.
 */
const NotConfigured: FC<{ host: string }> = ({ host }) => {
  const { name, rest } = brand(host);
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width,initial-scale=1" />
        <title>{name} · not configured</title>
        <style dangerouslySetInnerHTML={{ __html: CSS }} />
      </head>
      <body>
        <div class="setup">
          <h1>
            🔧 <b>{name}</b>
            {rest}
          </h1>
          <p>
            This CDN has no explorer password yet, so nobody can sign in — including you. Object
            URLs still work; the explorer is closed until you set one.
          </p>
          <code>wrangler secret put CDN_PASSWORD</code>
          <p>
            That is the only value this Worker needs. `CDN_UPLOAD_TOKEN` (scripts, the CLI, the
            hooks) and `CDN_SESSION_SECRET` are optional — `cdn setup` provisions them, and without
            them the write path is simply closed rather than open.
          </p>
        </div>
      </body>
    </html>
  );
};

/** `host` is the request's — the login page brands itself with the host you
    typed, so a preview build never claims to be production. */
export const loginPage = (host: string, error?: string): string =>
  `<!doctype html>${<Login host={host} error={error} />}`;

/** Shown at `/login` when the instance has no password configured at all. */
export const notConfiguredPage = (host: string): string =>
  `<!doctype html>${<NotConfigured host={host} />}`;
