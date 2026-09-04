import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Run tests inside workerd with the bindings from wrangler.jsonc — env.BUCKET is
// a local Miniflare R2 (reset between tests). No real R2, no passage. Secrets are
// NOT in wrangler.jsonc (and .dev.vars is gitignored, absent in CI), so inject
// known ones here; the tests use the same literals ("test-upload-token" for the
// upload bearer, "test-password" for the login gate).
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          CDN_UPLOAD_TOKEN: "test-upload-token",
          CDN_PASSWORD: "test-password",
          // Blanked deliberately: .dev.vars may hold a REAL Cache Purge token on a
          // laptop, and a test suite must never reach api.cloudflare.com. The zone
          // purge tests set it per-test, with global fetch stubbed.
          CDN_PURGE_TOKEN: "",
        },
      },
    }),
  ],
});
