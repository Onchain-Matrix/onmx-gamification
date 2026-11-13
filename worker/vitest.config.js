import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            SESSION_SECRET: "test-session-secret-at-least-32-chars-long!!",
            ALLOW_TEST_FIXTURE_RECEIPTS: "1",
            ADMIN_TOKEN: "test-admin-token-0123456789abcdef",
            ALLOWED_ORIGIN: "https://onchain-matrix.github.io",
            SIWE_DOMAIN: "onchain-matrix.github.io",
            SIWE_URI: "https://onchain-matrix.github.io/onmx-gamification/",
          },
        },
      },
    },
  },
});
