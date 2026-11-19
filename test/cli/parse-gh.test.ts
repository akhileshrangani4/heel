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
    // Paths WHATWG URL would rewrite but Go's url.Parse, and so gh, reads as written.
    for (const value of [
      "https://github.com/evil/../acme/web",
      "https://github.com/evil/other\\..\\..\\acme\\web",
      "https://github.com/evil/other/%2e%2e/%2e%2e/acme/web",
      "https://github.com/acme/web/pull/1",
    ]) {
      expect(normalizeGhRepo(value), value).toBeUndefined();
    }
    expect(normalizeGhRepo("https://github.com/acme/web/")).toBe("acme/web");
    // pflag keeps the last value of a repeated string flag; so does heel.
    expect(gh("pr", "view", "1", "-R", "a/one", "-R", "b/two").repo).toBe("b/two");
  });

  it("reads -R on every group gh gives it, before or after the subcommand", () => {
    for (const args of [
      ["issue", "comment", "-R", "acme/web", "5", "--body", "x"],
      ["issue", "-R", "acme/web", "comment", "5", "--body", "x"],
      ["-R", "acme/web", "issue", "close", "5"],
      ["release", "upload", "v1", "a.zip", "-R", "acme/web"],
      ["run", "view", "123", "--repo=acme/web"],
      ["label", "list", "-R", "acme/web"],
      ["cache", "list", "-R", "acme/web"],
      ["ruleset", "view", "7", "-R", "acme/web"],
      ["workflow", "run", "ci.yml", "-R", "acme/web"],
      ["secret", "list", "-R", "acme/web"],
      ["variable", "get", "NAME", "-R", "acme/web"],
      ["repo", "deploy-key", "list", "-R", "acme/web"],
      ["repo", "read-file", "README.md", "-R", "acme/web"],
      ["discussion", "view", "3", "-R", "acme/web"],
    ]) {
      const parsed = gh(...args);
      expect(parsed.refusals, args.join(" ")).toEqual([]);
      expect(parsed.repo, args.join(" ")).toBe("acme/web");
      expect(parsed.takesRepo, args.join(" ")).toBe(true);
    }
    // Without -R or a URL these read the repo from git remotes, which rules can't see.
    expect(gh("issue", "comment", "5", "--body", "x")).toMatchObject({ takesRepo: true });
    expect(gh("issue", "comment", "5", "--body", "x").repo).toBeUndefined();
  });

  it("refuses an argument that names a second repo, unless it's -R's own", () => {
    for (const [args, argument] of [
      [["label", "clone", "evil/other", "-R", "acme/web"], "evil/other"],
      [["issue", "transfer", "5", "evil/other", "-R", "acme/web"], "evil/other"],
      [["issue", "develop", "5", "--branch-repo", "evil/other", "-R", "acme/web"], "evil/other"],
      [
        ["issue", "develop", "5", "--branch-repo", "ghe.corp.example/x/y", "-R", "acme/web"],
        "ghe.corp.example/x/y",
      ],
    ] as const) {
      expect(gh(...args).refusals, args.join(" ")).toContainEqual({
        kind: "ambiguous_repo",
        argument,
      });
    }
    expect(gh("issue", "transfer", "5", "Acme/Web", "-R", "acme/web").refusals).toEqual([]);
    expect(
      gh("issue", "develop", "5", "--branch-repo", "acme/web", "-R", "acme/web").refusals,
    ).toEqual([]);
  });

  it("treats an org or user secret, variable or ruleset as not the repo's, and refuses -R with it", () => {
    for (const [args, flag] of [
      [["secret", "set", "T", "--org", "acme", "-R", "acme/web"], "--org"],
      [["secret", "list", "--user", "-R", "acme/web"], "--user"],
      [["secret", "set", "T", "--repos", "evil/other", "-R", "acme/web"], "--repos"],
      [["variable", "list", "-o", "acme", "-R", "acme/web"], "--org"],
      [["ruleset", "list", "--org", "acme", "-R", "acme/web"], "--org"],
    ] as const) {
      expect(gh(...args).refusals, args.join(" ")).toContainEqual({
        kind: "ambiguous_repo",
        argument: flag,
      });
    }
    // Without -R it acts on the org, as before: no repo for a rule to match, and none required.
    const org = gh("secret", "list", "--org", "acme");
    expect(org.refusals).toEqual([]);
    expect(org.repo).toBeUndefined();
    expect(org.takesRepo).toBeUndefined();
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

  it("takes the repo from a github.com URL, and refuses one it can't pin or that disagrees with -R", () => {
    expect(gh("pr", "comment", "https://github.com/Acme/Web/pull/7", "--body", "x").repo).toBe(
      "acme/web",
    );
    expect(gh("issue", "view", "HTTP://GITHUB.COM/acme/web/issues/5#top").repo).toBe("acme/web");
    for (const url of [
      "https://www.github.com/evil/other/pull/7",
      "https://evil.github.com/evil/other/pull/7",
      "https://github.com:443/evil/other/pull/7",
      "https://x@github.com/evil/other/pull/7",
      "https://WWW.GitHub.com/evil/other/pull/7",
      "https://ghe.corp.example/evil/other/pull/7",
      "https:github.com/evil/other/pull/7",
      "https://github.com/evil/other/issues/7",
      "https://github.com/evil/other/PULL/7",
      "https://github.com/evil/other.git/pull/7",
      "https://github.com/acme/web/pull/7?%2e",
      "https://github.com/acme/web",
    ]) {
      for (const args of [
        ["pr", "comment", url, "-R", "acme/web", "--body", "x"],
        ["pr", "close", url, "-R", "acme/web"],
      ]) {
        expect(gh(...args).refusals, url).toContainEqual({ kind: "ambiguous_repo", argument: url });
      }
    }
    expect(
      gh("pr", "comment", "https://github.com/evil/other/pull/7", "-R", "acme/web").refusals,
    ).toContainEqual({ kind: "ambiguous_repo", argument: "https://github.com/evil/other/pull/7" });
    // Outside pr and issue, gh reads no URL heel maps, so any URL argument is refused.
    expect(gh("run", "view", "https://github.com/acme/web/pull/7").refusals).toContainEqual(
      expect.objectContaining({ kind: "ambiguous_repo" }),
    );
  });

  it("reads --json as taking its field list, as gh does", () => {
    const view = gh("pr", "view", "-R", "acme/web", "--json", "title", "7");
    expect(view.cli.flags["json"]).toBe("title");
    expect(view.refusals).toEqual([]);
    expect(gh("pr", "view", "7", "-R", "acme/web", "--json=title").refusals).toEqual([]);
    const smuggled = gh(
      "pr",
      "view",
      "-R",
      "acme/web",
      "--json",
      "title",
      "https://github.com/other/repo/pull/1",
    );
    expect(smuggled.refusals).toContainEqual(expect.objectContaining({ kind: "ambiguous_repo" }));
  });

  it("types every gh --json that lists fields as taking a value", () => {
    for (const [key, def] of Object.entries(GH_TABLE.commands)) {
      const json = [...(def.local ?? []), ...(def.persistent ?? [])].find(([n]) => n === "json");
      // `gh workflow run --json` is a bool: read the inputs as JSON from stdin.
      if (json !== undefined) expect(json[2], key).toBe(key === "workflow run" ? "bool" : "value");
    }
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
