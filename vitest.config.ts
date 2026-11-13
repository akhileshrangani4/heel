import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // Forks, not threads: heel sets a process umask and opens native SQLite
    // handles, and process.umask() is unavailable inside worker threads.
    pool: "forks",
    testTimeout: 15_000,
  },
});
