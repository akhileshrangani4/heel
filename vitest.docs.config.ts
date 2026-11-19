import { defineConfig } from "vitest/config";

/**
 * Regenerates the screenshots in docs/images from heel's real web app
 * (`pnpm docs:screenshots`). Needs Chromium, like the browser tests.
 */
export default defineConfig({
  test: {
    include: ["e2e/docs/**/*.test.ts"],
    pool: "forks",
    testTimeout: 120_000,
  },
});
