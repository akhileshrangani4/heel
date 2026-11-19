/**
 * Writes the built-in service tables into docs/rules-reference.md, between
 * its generated markers. With `--check` it writes nothing and fails when the
 * page is stale; test/scripts/rules-reference.test.ts runs the same
 * comparison in CI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { renderServiceTables, withGenerated } from "./lib/rules-reference.ts";

const root = join(import.meta.dirname, "..");
const target = join(root, "docs/rules-reference.md");
const current = readFileSync(target, "utf8");
const updated = withGenerated(current, renderServiceTables());

if (process.argv.includes("--check")) {
  if (updated !== current) {
    console.error(
      `${relative(root, target)} is stale. Run \`pnpm gen:rules-reference\` and commit the result.`,
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(target, updated);
  process.stdout.write(`wrote ${relative(root, target)}\n`);
}
