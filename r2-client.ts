// Bun-only R2/S3 client, shared by the explorer's storage layer and the `share`
// CLI. Lives here (not in lib/cdn.ts) because it imports `bun` and shells out to
// `passage` — lib/cdn.ts stays pure so it survives the Worker promotion.

import { $, S3Client } from "bun";

import { BUCKET } from "./lib/cdn.ts";

let clientPromise: Promise<S3Client> | null = null;

export function getR2Client(): Promise<S3Client> {
  clientPromise ??= (async () => {
    const [accountId, accessKeyId, secretAccessKey] = (
      await Promise.all([
        $`passage show tokens/cloudflare/personal/account-id`.text(),
        $`passage show tokens/cloudflare/personal/r2-cdn/access-key-id`.text(),
        $`passage show tokens/cloudflare/personal/r2-cdn/secret-access-key`.text(),
      ])
    ).map((s) => s.trim());
    return new S3Client({
      accessKeyId,
      secretAccessKey,
      bucket: BUCKET,
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    });
  })();
  return clientPromise;
}
