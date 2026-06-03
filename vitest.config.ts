import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

// Run tests inside workerd with the bindings from wrangler.jsonc — env.BUCKET is
// a local Miniflare R2 (reset between tests). No real R2, no passage.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
