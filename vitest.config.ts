import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Run tests inside workerd with the bindings from wrangler.jsonc — env.BUCKET is
// a local Miniflare R2 (reset between tests). No real R2, no network. Secrets are
// NOT in wrangler.jsonc (and .dev.vars is gitignored, absent in CI), so inject
// known ones here; the tests use the same literals ("test-upload-token" for the
// upload bearer, "test-password" for the login gate).
export default defineConfig({
  // Scoped to src/ on purpose. The repo has two runtimes and therefore two test
  // runners: the Worker runs in workerd (here), the hooks run in Bun (`bun test
  // hooks/`, bun:test). Without this, vitest's default glob would sweep up
  // hooks/*.test.ts and run Bun code inside workerd, where `Bun` doesn't exist.
  // `bun run check` runs both.
  test: { include: ["src/**/*.test.ts"] },
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
