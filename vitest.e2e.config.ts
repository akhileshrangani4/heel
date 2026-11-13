import { defineConfig } from "vitest/config";

/**
 * End-to-end suites that need the host: real bubblewrap and user namespaces.
 * `pnpm test` leaves them out, so the main job runs anywhere; CI runs them in
 * the Linux sandbox job.
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.test.ts"],
    pool: "forks",
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
