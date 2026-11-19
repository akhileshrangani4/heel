import { describe, expect, it } from "vitest";
import {
  classifyProbe,
  flagKind,
  GH_REPO_FLAG_ROOTS,
  missingInheritedFlags,
  missingRepoFlags,
  parseGhHelpFlags,
  parseGhReference,
  withHelpFlags,
} from "../../scripts/lib/cli-tables.ts";
import type { CommandTable } from "../../src/definitions/cli/cobra.ts";
import { GH_TABLE } from "../../src/definitions/cli/generated/gh-table.ts";

/** From gh 2.99.0: `gh help reference` lists no flags for `gh issue <command>`. */
const ISSUE_REFERENCE = `## gh issue <command>

Manage issues

### gh issue close {<number> | <url>} [flags]

Close issue

  -c, --comment string        Leave a closing comment
`;

/** From gh 2.99.0: `gh issue --help`. */
const ISSUE_HELP = `Work with GitHub issues.

USAGE
  gh issue <command> [flags]

TARGETED COMMANDS
  close:         Close issue

FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format

INHERITED FLAGS
  --help   Show help for command

ARGUMENTS
  An issue can be supplied as argument in any of the following formats:
  - by number, e.g. "123"; or
`;

/** From gh 2.99.0: `gh issue close --help`. */
const ISSUE_CLOSE_HELP = `Close issue

USAGE
  gh issue close {<number> | <url>} [flags]

FLAGS
  -c, --comment string        Leave a closing comment
      --duplicate-of string   Mark as duplicate of another issue by number or URL

INHERITED FLAGS
      --help                     Show help for command
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format

EXAMPLES
  $ gh issue close 123 --comment "--not-a-flag"
`;

describe("gh help pages fill in the group flags the reference leaves out", () => {
  it("reads FLAGS and INHERITED FLAGS, stopping at the next section", () => {
    expect(parseGhHelpFlags(ISSUE_HELP, "FLAGS")).toEqual([
      { long: "repo", short: "R", placeholder: "[HOST/]OWNER/REPO" },
    ]);
    expect(parseGhHelpFlags(ISSUE_HELP, "INHERITED FLAGS")).toEqual([{ long: "help", short: "" }]);
    expect(parseGhHelpFlags(ISSUE_CLOSE_HELP, "INHERITED FLAGS")).toEqual([
      { long: "help", short: "" },
      { long: "repo", short: "R", placeholder: "[HOST/]OWNER/REPO" },
    ]);
    expect(parseGhHelpFlags("USAGE\n  gh x\n", "FLAGS")).toEqual([]);
  });

  it("adds a group's -R that the reference didn't list", () => {
    const [issue, close] = parseGhReference(ISSUE_REFERENCE);
    if (issue === undefined || close === undefined) throw new Error("reference didn't parse");
    expect(issue.flags).toEqual([]);
    const merged = withHelpFlags(issue, parseGhHelpFlags(ISSUE_HELP, "FLAGS"));
    expect(merged.flags.map((flag) => flag.long)).toEqual(["repo"]);
    // Nothing the reference already listed is doubled.
    const own = withHelpFlags(close, parseGhHelpFlags(ISSUE_CLOSE_HELP, "FLAGS"));
    expect(own.flags.map((flag) => flag.long)).toEqual(["comment", "duplicate-of"]);
  });

  it("names an inherited flag no parent has as persistent", () => {
    const inherited = parseGhHelpFlags(ISSUE_CLOSE_HELP, "INHERITED FLAGS");
    const without: CommandTable = {
      ...GH_TABLE,
      commands: { ...GH_TABLE.commands, issue: {} },
    };
    expect(missingInheritedFlags(GH_TABLE, ["issue", "close"], inherited)).toEqual([]);
    expect(missingInheritedFlags(without, ["issue", "close"], inherited)).toEqual(["-R/--repo"]);
  });
});

describe("the gh table's -R", () => {
  it("reaches every command gh gives it", () => {
    expect(missingRepoFlags(GH_TABLE)).toEqual([]);
    for (const root of GH_REPO_FLAG_ROOTS) expect(GH_TABLE.commands[root], root).toBeDefined();
  });

  it("names each command that lost it", () => {
    const without: CommandTable = {
      ...GH_TABLE,
      commands: { ...GH_TABLE.commands, release: {} },
    };
    const missing = missingRepoFlags(without);
    expect(missing).toContain("release upload");
    expect(missing).toContain("release");
    expect(missing.every((key) => key.startsWith("release"))).toBe(true);
  });
});

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
