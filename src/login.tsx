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
  .err{color:var(--red);font-size:13px;margin:0}`;

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

/** `host` is the request's — the login page brands itself with the host you
    typed, so a preview build never claims to be production. */
export const loginPage = (host: string, error?: string): string =>
  `<!doctype html>${<Login host={host} error={error} />}`;
