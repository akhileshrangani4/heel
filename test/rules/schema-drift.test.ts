import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderRulesJsonSchema } from "../../src/core/rules/schema.ts";

const SCHEMA_FILE = join(import.meta.dirname, "..", "..", "schema", "heel-rules.schema.json");

describe("schema/heel-rules.schema.json", () => {
  it("matches the Zod rules schema byte for byte (run `pnpm gen:schema` to refresh)", () => {
    expect(readFileSync(SCHEMA_FILE, "utf8")).toBe(renderRulesJsonSchema());
  });

  it("is a closed Draft 2020-12 schema for { rules, hide }", () => {
    const schema: { $schema: unknown; additionalProperties: unknown; properties: object } =
      JSON.parse(renderRulesJsonSchema());
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties)).toEqual(["rules", "hide"]);
  });

  it("ends with a newline, so editors and the drift check agree", () => {
    expect(renderRulesJsonSchema().endsWith("}\n")).toBe(true);
  });
});
