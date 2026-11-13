/**
 * `pnpm test:invariants`: fails when an invariant listed in
 * test/invariants.ts has no tagged test. It checks that the claim exists;
 * `pnpm test` checks that the claim holds.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_INVARIANTS } from "../test/invariants.ts";
import {
  checkInvariants,
  compareIds,
  countTaggedIds,
  INVARIANT_ID,
  type TestTitle,
  testTitles,
} from "./lib/invariants.ts";

const root = join(import.meta.dirname, "..");
/** Where test files live now (test/) and where the end-to-end suites will (e2e/). */
const TEST_DIRS = ["test", "e2e"];
const TEST_FILE = /\.(?:test|spec)\.ts$/;

function testFiles(): string[] {
  return TEST_DIRS.map((dir) => join(root, dir))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) =>
      readdirSync(dir, { recursive: true, encoding: "utf8" })
        .filter((file) => TEST_FILE.test(file))
        .map((file) => join(dir, file)),
    )
    .sort();
}

const required = Object.keys(REQUIRED_INVARIANTS).sort(compareIds);
const malformed = required.filter((id) => !INVARIANT_ID.test(id));
if (malformed.length > 0) {
  console.error(`test/invariants.ts lists malformed ids: ${malformed.join(", ")}`);
  process.exit(1);
}

const titles: TestTitle[] = testFiles().flatMap((file) => testTitles(readFileSync(file, "utf8")));
const tagged = countTaggedIds(titles);
const { missing, unlisted } = checkInvariants(required, tagged);

for (const id of required) {
  const count = tagged.get(id) ?? 0;
  const status = count > 0 ? "ok  " : "MISS";
  process.stdout.write(`${status} ${id} (${count} tests)  ${REQUIRED_INVARIANTS[id]}\n`);
}
if (unlisted.length > 0) {
  process.stdout.write(`\nTagged but not listed in test/invariants.ts: ${unlisted.join(", ")}\n`);
}
if (missing.length > 0) {
  console.error(
    `\n${missing.length} listed invariant(s) have no tagged test: ${missing.join(", ")}.\n` +
      `Tag a test that proves each one, e.g. it("${missing[0]}: …", …).`,
  );
  process.exitCode = 1;
}
