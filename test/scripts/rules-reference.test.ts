import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  factProblems,
  renderServiceTables,
  SERVICES,
  withGenerated,
} from "../../scripts/lib/rules-reference.ts";
import { actionsFor } from "../../src/drafting/draft.ts";
import { BUILT_IN_PROVIDERS } from "../../src/vault/connect.ts";

const PAGE = join(import.meta.dirname, "..", "..", "docs", "rules-reference.md");

describe("docs/rules-reference.md built-in service tables", () => {
  it("describe every built-in tool, and only those", () => {
    expect(factProblems()).toEqual([]);
  });

  it("name only actions the built-in providers have", () => {
    const known = new Set(actionsFor(BUILT_IN_PROVIDERS));
    for (const service of SERVICES) {
      for (const [tool, facts] of Object.entries(service.facts)) {
        for (const [, action] of facts.action.matchAll(/`([a-z]+(?:\.[a-z]+)+)`/g)) {
          expect(known, `${service.provider} ${tool}`).toContain(action);
        }
      }
    }
  });

  it("are up to date (run `pnpm gen:rules-reference` to refresh)", () => {
    const page = readFileSync(PAGE, "utf8");
    expect(withGenerated(page, renderServiceTables())).toBe(page);
  });
});
