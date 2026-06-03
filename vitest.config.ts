import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Run tests inside workerd with the bindings from wrangler.jsonc — env.BUCKET is
// a local Miniflare R2 (reset between tests). No real R2, no passage. The upload
// bearer is a secret (not in wrangler.jsonc), so inject a known one here; the
// tests use the same literal ("test-upload-token").
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { CDN_UPLOAD_TOKEN: "test-upload-token" } },
    }),
  ],
});
