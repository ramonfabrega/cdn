// The writer half of the hosts file. `cdn auth login` is the only thing in this
// project that creates one; everything else reads (hosts.ts) or, on a Mac with
// no Bun, `source`s it (macos/quickshare).
//
// The mode is the whole reason this is a module rather than three lines inline.
// A bearer token readable by every process on the machine is a bearer token you
// have to rotate, and a `Bun.write` followed by a hopeful `chmod` is not a
// guarantee — a umask, an odd filesystem, or a pre-existing file with the wrong
// bits all end the same way. So: write, tighten, read back, and if the result is
// not 0600, delete it and say so. Refusing to store a token is recoverable.
// Storing one the world can read is not.

import { chmod, mkdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

import { hostsDir } from "./hosts.ts";

export type Written =
  | { ok: true; file: string; mode: number }
  | { ok: false; error: string; file?: string };

const MODE = 0o600;

export async function writeHostFile(
  host: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env
): Promise<Written> {
  const clean = host
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "");
  // The filename IS the host, so a host that isn't a filename would silently
  // become a different one — or escape the directory entirely.
  if (!clean || clean.includes("/") || clean.startsWith(".")) {
    return { ok: false, error: `not a usable host name: ${host}` };
  }

  const dir = hostsDir(env);
  const file = join(dir, `${clean}.env`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await Bun.write(file, `CDN_TOKEN=${token}\n`);
    await chmod(file, MODE);
  } catch (e) {
    return { ok: false, error: `could not write ${file}: ${e instanceof Error ? e.message : e}` };
  }

  const mode = ((await stat(file).catch(() => null))?.mode ?? 0) & 0o777;
  if (mode !== MODE) {
    await unlink(file).catch(() => {});
    return {
      ok: false,
      error: `${file} ended up mode ${mode.toString(8)} instead of 0600 — refusing to leave a token there`,
      file,
    };
  }
  return { ok: true, file, mode };
}
