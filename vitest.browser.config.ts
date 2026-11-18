import { defineConfig } from "vitest/config";

/**
 * The approval page in a real browser: Chromium through Playwright, with a
 * virtual WebAuthn authenticator (spec: D4 tests). Needs a Chromium install
 * (`pnpm exec playwright install chromium`), so it runs in its own CI job.
 */
export default defineConfig({
  test: {
    include: ["e2e/browser/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
