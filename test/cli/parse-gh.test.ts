import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { GH_TABLE } from "../../src/definitions/cli/generated/gh-table.ts";
import { ghMergeBypassFlags, normalizeGh, normalizeGhRepo } from "../../src/definitions/cli/gh.ts";
import {
  GH_ACTIONS,
  GH_PERSISTENCE,
  GH_RUNS_REPO_CODE,
  ghCommandMapping,
} from "../../src/definitions/cli/gh-actions.ts";
import { type CliArgv, normalizeCliArgv } from "../../src/definitions/cli/index.ts";
import { GH_REDIRECT_FLAGS, GH_RESERVED_ENV } from "../../src/definitions/cli/redirect.ts";
import { cobraOrderings, meaning } from "../helpers/cli-argv.ts";

const gh = (...args: string[]) => normalizeGh(["gh", ...args]);

describe("gh: finding the verb", () => {
  it("I-32: a persistent flag before the verb still resolves the command", () => {
    const merge = gh("-R", "acme/web", "pr", "merge", "12", "--squash");
    expect(merge.cli).toMatchObject({ command: "gh", verb: "pr", subcommand: "merge" });
    expect(merge.action).toBe("github.merge");
    expect(merge.repo).toBe("acme/web");
    expect(merge.refusals).toEqual([]);
  });

  it("I-32: every order and spelling gh accepts for one merge means the same call", () => {
    const expected = meaning(gh("pr", "merge", "12", "--repo", "acme/web", "--squash", "-d"));
    fc.assert(
      fc.property(
        cobraOrderings({
          command: "gh",
          path: ["pr", "merge"],
          early: [
            [["-R", "acme/web"], ["-Racme/web"], ["--repo", "acme/web"], ["--repo=acme/web"]],
          ],
          late: [
            [["--squash"], ["-s"], ["--squash=true"]],
            [["-d"], ["--delete-branch"]],
          ],
          positionals: ["12"],
        }),
        (argv) => {
          expect(meaning(normalizeGh(argv))).toEqual(expected);
        },
      ),
      { numRuns: 300 },
    );
  });

  it("resolves gh's built-in aliases to their command", () => {
    expect(gh("pr", "ls").cli.subcommand).toBe("list");
    expect(gh("pr", "ls").action).toBe("github.read");
    expect(gh("pr", "co", "12").cli.subcommand).toBe("checkout");
  });

  it("denies config aliases and extensions: they aren't built-in commands", () => {
    for (const argv of [
      ["co", "12"],
      ["my-extension", "run"],
    ]) {
      expect(gh(...argv).refusals).toEqual([
        expect.objectContaining({ kind: "unparseable", reason: "unknown_command" }),
      ]);
    }
  });

  it("denies a flag the command doesn't define, rather than guessing its arity", () => {
    expect(gh("pr", "merge", "12", "--no-such-flag").refusals).toEqual([
      expect.objectContaining({ kind: "unparseable", reason: "unknown_flag" }),
    ]);
    // A local flag before its command is unknown where cobra reads it, and would swallow the verb.
    expect(gh("--admin", "pr", "merge", "12").refusals).toEqual([
      expect.objectContaining({ kind: "unparseable" }),
    ]);
  });

  it("keeps the raw argv exactly as sent", () => {
    const argv: CliArgv = ["gh", "-R", "Acme/Web", "pr", "view", "1"];
    expect(normalizeGh(argv).cli.argv).toEqual(argv);
  });

  it("marks --help as help: the program prints usage and runs nothing", () => {
    expect(gh("pr", "merge", "--help")).toMatchObject({ help: true, refusals: [] });
    expect(gh("pr", "merge", "12", "--help=false").help).toBe(false);
  });
});

describe("gh: action map", () => {
  it.each([
    [["pr", "view", "1"], "github.read", "read"],
    [["issue", "list"], "github.read", "read"],
    [["run", "view", "9"], "github.read", "read"],
    [["pr", "create", "--fill"], "github.pr.create", "write"],
    [["pr", "edit", "1", "--title", "x"], "github.pr.update", "write"],
    [["pr", "comment", "1", "--body", "x"], "github.comment", "write"],
    [["issue", "create", "--title", "x"], "github.issue.create", "write"],
    [["issue", "close", "4"], "github.issue.update", "write"],
    [["pr", "merge", "1"], "github.merge", "write"],
    [["api", "/user"], "github.api", "write"],
  ] as const)("%j is %s (%s)", (args, action, kind) => {
    expect(gh(...args)).toMatchObject({ action, kind });
  });

  it("I-20: a command with no mapping gets no action and no kind", () => {
    const unmapped = gh("gist", "list");
    expect(unmapped.action).toBeUndefined();
    expect(unmapped.kind).toBeUndefined();
    expect(unmapped.refusals).toEqual([]);
  });

  it("every mapped, persistent and repo-code command exists in the gh table", () => {
    const keys = [...Object.keys(GH_ACTIONS), ...GH_PERSISTENCE, ...GH_RUNS_REPO_CODE];
    for (const key of keys) expect(Object.hasOwn(GH_TABLE.commands, key), key).toBe(true);
  });

  it("looks up only its own entries, never Object.prototype", () => {
    expect(ghCommandMapping(["constructor"])).toBeUndefined();
    expect(ghCommandMapping(["toString"])).toBeUndefined();
  });

  it("normalizes --repo to a lower-cased owner/name on github.com", () => {
    expect(normalizeGhRepo("Acme/Web")).toBe("acme/web");
    expect(normalizeGhRepo("github.com/Acme/Web")).toBe("acme/web");
    expect(normalizeGhRepo("https://github.com/Acme/Web.git")).toBe("acme/web");
    expect(normalizeGhRepo("ghe.corp.com/acme/web")).toBeUndefined();
    expect(normalizeGhRepo("acme")).toBeUndefined();
    // pflag keeps the last value of a repeated string flag; so does heel.
    expect(gh("pr", "view", "1", "-R", "a/one", "-R", "b/two").repo).toBe("b/two");
  });
});

describe("gh: what heel refuses before rules", () => {
  it("I-70: deploy keys, SSH keys, secrets and variables are persistence", () => {
    for (const args of [
      ["repo", "deploy-key", "add", "k.pub"],
      ["ssh-key", "add", "k.pub"],
      ["secret", "set", "TOKEN", "--body", "x"],
      ["variable", "set", "NAME", "--body", "x"],
    ]) {
      expect(gh(...args).persistence, args.join(" ")).toBe(true);
    }
    expect(gh("pr", "view", "1").persistence).toBeUndefined();
  });

  it("refuses commands that run git in the agent's checkout with the token set", () => {
    for (const [args, command] of [
      [["pr", "checkout", "12"], "gh pr checkout"],
      [["pr", "co", "12"], "gh pr checkout"],
      [["repo", "clone", "acme/web"], "gh repo clone"],
      [["repo", "sync"], "gh repo sync"],
    ] as const) {
      expect(gh(...args).refusals).toContainEqual({ kind: "runs_repo_code", command });
    }
  });

  it("detects --hostname, the spec's redirect flag, wherever it appears", () => {
    expect(GH_REDIRECT_FLAGS).toEqual(["hostname"]);
    for (const args of [
      ["api", "--hostname", "evil.example", "/user"],
      ["api", "/user", "--hostname=evil.example"],
      ["auth", "status", "-h", "evil.example"],
    ]) {
      expect(gh(...args).refusals).toContainEqual({
        kind: "redirects_endpoint",
        option: "--hostname",
      });
    }
  });

  it("detects a --repo on another host as a redirect, and sets no repo", () => {
    for (const repo of ["ghe.corp.com/acme/web", "https://ghe.corp.com/acme/web"]) {
      const view = gh("pr", "view", "1", "--repo", repo);
      expect(view.refusals).toContainEqual({ kind: "redirects_endpoint", option: "--repo" });
      expect(view.repo).toBeUndefined();
    }
    expect(gh("pr", "view", "1", "--repo", "github.com/acme/web").refusals).toEqual([]);
  });

  it("reserves the spec's GH_* overrides: heel sets them, never the agent", () => {
    for (const name of ["GH_HOST", "GH_REPO", "GH_DEBUG", "GH_CONFIG_DIR", "GH_TOKEN"]) {
      expect(GH_RESERVED_ENV).toContain(name);
    }
  });

  it("names the merge flags that skip required checks", () => {
    expect(ghMergeBypassFlags(gh("pr", "merge", "1", "--admin"))).toEqual(["admin"]);
    expect(ghMergeBypassFlags(gh("pr", "merge", "--auto", "1", "--admin"))).toEqual([
      "admin",
      "auto",
    ]);
    expect(ghMergeBypassFlags(gh("pr", "merge", "1", "--admin=false"))).toEqual([]);
    expect(ghMergeBypassFlags(gh("pr", "view", "1"))).toEqual([]);
  });

  it("dispatches by argv[0]: normalizeCliArgv routes gh to this parser", () => {
    expect(meaning(normalizeCliArgv(["gh", "pr", "view", "1"]))).toEqual(
      meaning(gh("pr", "view", "1")),
    );
  });
});
