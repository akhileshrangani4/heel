import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  factProblems,
  renderServiceTables,
  withGenerated,
} from "../../scripts/lib/rules-reference.ts";

const PAGE = join(import.meta.dirname, "..", "..", "docs", "rules-reference.md");

describe("docs/rules-reference.md built-in service tables", () => {
  it("describe every built-in tool, and only those", () => {
    expect(factProblems()).toEqual([]);
  });

  it("are up to date (run `pnpm gen:rules-reference` to refresh)", () => {
    const page = readFileSync(PAGE, "utf8");
    expect(withGenerated(page, renderServiceTables())).toBe(page);
  });
});
