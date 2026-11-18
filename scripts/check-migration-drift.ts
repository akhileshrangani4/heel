/**
 * Fails when src/store/schema.ts has changes that no committed migration
 * covers. drizzle-kit regenerates against a scratch copy of the migrations
 * folder; any new file it writes there is drift.
 *
 * drizzle-kit exits 0 even when it crashes, so success needs a positive
 * verdict: its "No schema changes" line and no new files.
 */
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, relative } from "node:path";

const root = join(import.meta.dirname, "..");
const committed = join(root, "src/store/migrations");
// drizzle-kit prefixes `--out` with "./", so the scratch folder must sit
// inside the repo and be passed as a relative path.
const cacheDir = join(root, "node_modules/.cache");
mkdirSync(cacheDir, { recursive: true });
const scratch = mkdtempSync(join(cacheDir, "heel-drift-"));

function listFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
}

function fail(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

try {
  cpSync(committed, scratch, { recursive: true });
  const before = listFiles(scratch);
  const result = spawnSync(
    join(root, "node_modules/.bin/drizzle-kit"),
    [
      "generate",
      "--dialect=sqlite",
      "--schema=./src/store/schema.ts",
      `--out=${relative(root, scratch)}`,
      "--name=drift",
    ],
    { cwd: root, encoding: "utf8" },
  );
  const output = `${result.stdout}${result.stderr}`;
  const added = listFiles(scratch).filter((file) => !before.includes(file));
  if (added.length > 0) {
    fail(
      `Schema drift: src/store/schema.ts changed without a migration (drizzle-kit wrote ${added.join(", ")}). Run \`pnpm db:generate\` and commit the result.`,
    );
  } else if (result.status !== 0 || !output.includes("No schema changes")) {
    fail(`drizzle-kit gave no clean verdict (exit ${result.status}):\n${output}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
