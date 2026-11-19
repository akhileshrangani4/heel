import { describe, expect, it } from "vitest";
import { classifyProbe, flagKind } from "../../scripts/lib/cli-tables.ts";

describe("classifyProbe", () => {
  it("reads pflag's own messages", () => {
    expect(classifyProbe("unknown flag: --nope", "nope")).toBe("unknown");
    expect(classifyProbe("flag needs an argument: --jq", "jq")).toBe("needs_value");
    expect(classifyProbe("Show help for command", "web")).toBe("accepted");
  });

  it("reads gh's rewritten --json error as needing a value", () => {
    const output =
      "Specify one or more comma-separated fields for `--json`:\n  additions\n  title\n";
    expect(classifyProbe(output, "json")).toBe("needs_value");
  });
});

describe("flagKind for gh", () => {
  it("follows the probe when the listing agrees", () => {
    expect(flagKind("gh", { long: "json", short: "", placeholder: "fields" }, true)).toBe("value");
    expect(flagKind("gh", { long: "web", short: "w" }, false)).toBe("bool");
    expect(
      flagKind("gh", { long: "color", short: "", placeholder: 'string[="always"]' }, false),
    ).toBe("optional");
  });

  it("refuses to call a flag gh lists with a value a bool", () => {
    expect(() => flagKind("gh", { long: "json", short: "", placeholder: "fields" }, false)).toThrow(
      /--json/,
    );
    expect(() => flagKind("gh", { long: "web", short: "w" }, true)).toThrow(/--web/);
  });

  it("trusts the probe when the placeholder is a backquoted flag name", () => {
    expect(flagKind("gh", { long: "force", short: "f", placeholder: "--hostname" }, false)).toBe(
      "bool",
    );
    expect(
      flagKind("gh", { long: "succeed-on-no-caches", short: "", placeholder: "--all" }, false),
    ).toBe("bool");
    expect(flagKind("gh", { long: "value", short: "", placeholder: "--field" }, true)).toBe(
      "value",
    );
  });
});
