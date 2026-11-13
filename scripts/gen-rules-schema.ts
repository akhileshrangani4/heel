/**
 * Writes schema/heel-rules.schema.json from the Zod rules schema, the same
 * bytes `heel rules schema` prints. With `--check` it writes nothing and
 * fails when the committed file is stale; test/rules/schema-drift.test.ts
 * runs the same comparison in CI.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { renderRulesJsonSchema } from "../src/core/rules/schema.ts";
import { hasErrnoCode } from "../src/util/errno.ts";

const root = join(import.meta.dirname, "..");
const target = join(root, "schema/heel-rules.schema.json");
const rendered = renderRulesJsonSchema();

if (process.argv.includes("--check")) {
  let committed: string | null = null;
  try {
    committed = readFileSync(target, "utf8");
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) throw error;
  }
  if (committed !== rendered) {
    console.error(
      `${relative(root, target)} is ${committed === null ? "missing" : "stale"}. Run \`pnpm gen:schema\` and commit the result.`,
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(target, rendered);
  process.stdout.write(`wrote ${relative(root, target)}\n`);
}
