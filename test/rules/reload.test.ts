import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRuleSet, type RulesPaths, rulesPaths } from "../../src/config/rules.ts";
import {
  type ReloadOutcome,
  RulesHolder,
  type RulesWatcher,
  watchRules,
} from "../../src/config/rules-reload.ts";
import { YamlValidationError } from "../../src/config/yaml.ts";
import { effectiveDecision } from "../../src/core/rules/evaluate.ts";
import { facts, oneRule, run } from "./helpers.ts";

let home: string;
let paths: RulesPaths;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "heel-rules-"));
  paths = rulesPaths(home);
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function writeOrg(yaml: string): void {
  writeFileSync(paths.orgFile, yaml);
}

function writeOwner(user: string, yaml: string, name = `${user}.yaml`): void {
  mkdirSync(paths.ownersDir, { recursive: true });
  writeFileSync(join(paths.ownersDir, name), yaml);
}

/** The issues a failed load reports, as `file:line: message` relative to `$HEEL_HOME`. */
function loadIssues(): string[] {
  try {
    loadRuleSet(paths);
  } catch (error) {
    if (!(error instanceof YamlValidationError)) throw error;
    return error.issues.map(
      (issue) => `${issue.file.replace(`${home}/`, "")}:${issue.line}: ${issue.message}`,
    );
  }
  throw new Error("expected the load to fail");
}

const allowSends = oneRule("{ action: email.send }");
const send = facts({ action: "email.send", recipients: ["a@company.com"] });

describe("loading rules files", () => {
  it("loads the org file and one file per owner, named relative to $HEEL_HOME", () => {
    writeOrg(oneRule("{ recipients: { any_domain_in: [rival.com] } }", "deny"));
    writeOwner("alice", allowSends);
    writeOwner("bob", oneRule("{}", "ask"));
    const loaded = loadRuleSet(paths);
    expect(loaded.files).toEqual([
      { file: "org-rules.yaml", layer: "org", rules: 1, hide: 0 },
      { file: "rules/alice.yaml", layer: "owner", user: "alice", rules: 1, hide: 0 },
      { file: "rules/bob.yaml", layer: "owner", user: "bob", rules: 1, hide: 0 },
    ]);
    expect([...loaded.set.owners.keys()]).toEqual(["alice", "bob"]);
    expect(loaded.set.org?.rules[0]?.ref.file).toBe("org-rules.yaml");
  });

  it("treats a missing org file and a missing rules/ directory as no rules, so every call is denied", () => {
    const loaded = loadRuleSet(paths);
    expect(loaded.files).toEqual([]);
    expect(run(loaded.set, send).verdict).toMatchObject({
      decision: "deny",
      reason: "no_rule_matched",
    });
  });

  it("skips hidden files and editor leftovers, and warns about a .yml file", () => {
    writeOwner("alice", allowSends);
    writeOwner("alice", "not: [valid", "alice.yaml~");
    writeOwner("alice", "not: [valid", ".alice.yaml.swp");
    writeOwner("carol", allowSends, "carol.yml");
    const loaded = loadRuleSet(paths);
    expect([...loaded.set.owners.keys()]).toEqual(["alice"]);
    expect(loaded.warnings.map((w) => w.message)).toEqual(["ignored: rules files end in .yaml"]);
    expect(loaded.warnings[0]?.file).toBe(join(paths.ownersDir, "carol.yml"));
  });

  it("reports malformed YAML with its file and line", () => {
    writeOwner("alice", "rules:\n  - match: { action: email.send\n    then: allow\n");
    const [issue, ...rest] = loadIssues();
    expect(rest).toEqual([]);
    expect(issue).toMatch(/^rules\/alice\.yaml:\d+: /);
  });

  it("reports a schema error at the line of the offending key", () => {
    writeOwner("alice", "rules:\n  - match: { action: email.send }\n    then: maybe\n");
    expect(loadIssues()).toEqual([expect.stringMatching(/^rules\/alice\.yaml:3: /)]);
  });

  it("reports an unknown match key as a load error at its line", () => {
    writeOwner("alice", "rules:\n  - then: allow\n    match:\n      acount: gmail-work\n");
    expect(loadIssues()).toEqual([expect.stringMatching(/^rules\/alice\.yaml:4: /)]);
  });

  it("rejects duplicate keys instead of letting the last one win", () => {
    writeOwner("alice", "rules:\n  - match: {}\n    then: deny\n    then: allow\n");
    expect(loadIssues()).toEqual([expect.stringMatching(/^rules\/alice\.yaml:4: /)]);
  });

  it("reports every problem in every file at once", () => {
    writeOrg(oneRule("{}", "allow"));
    writeOwner("alice", "rules:\n  - match: {}\n    then: maybe\n");
    writeOwner("bob", allowSends);
    expect(loadIssues()).toEqual([
      "org-rules.yaml:3: org rules can only deny or ask (I-12)",
      expect.stringMatching(/^rules\/alice\.yaml:3: /),
    ]);
  });
});

describe("RulesHolder", () => {
  it("denies every call until a valid set has loaded", () => {
    writeOwner("alice", "rules: [");
    const holder = new RulesHolder(paths);
    const outcome = holder.reload();
    expect(outcome).toMatchObject({ ok: false, keptLastGood: false });
    expect(holder.set).toBeNull();
    expect(run(holder.set, send).verdict).toMatchObject({ reason: "rules_unavailable" });
  });

  it("keeps the last good set when a reload is invalid, and reports why", () => {
    writeOwner("alice", allowSends);
    const holder = new RulesHolder(paths);
    expect(holder.reload().ok).toBe(true);
    const good = holder.set;

    writeOwner("alice", "rules:\n  - match: { action: email.send }\n    then: maybe\n");
    const outcome = holder.reload();
    expect(outcome).toMatchObject({ ok: false, keptLastGood: true });
    expect(holder.set).toBe(good);
    expect(holder.lastError?.issues[0]?.file).toBe(join(paths.ownersDir, "alice.yaml"));
    expect(effectiveDecision(run(holder.set, send))).toBe("allow");
  });

  it("swaps nothing in when one file of several is invalid", () => {
    writeOrg(oneRule("{ action: email.remove }", "deny"));
    writeOwner("alice", allowSends);
    const holder = new RulesHolder(paths);
    holder.reload();
    const good = holder.set;

    // A valid edit to the org file and a broken owner file in the same reload.
    writeOrg(oneRule("{ action: email.send }", "deny"));
    writeOwner("alice", "rules: [");
    expect(holder.reload().ok).toBe(false);
    expect(holder.set).toBe(good);
    expect(effectiveDecision(run(holder.set, send))).toBe("allow");
  });

  it("swaps in a valid edit and clears the last error", () => {
    writeOwner("alice", allowSends);
    const holder = new RulesHolder(paths);
    holder.reload();
    writeOwner("alice", "rules: [");
    holder.reload();
    writeOwner("alice", oneRule("{ action: email.send }", "deny"));
    expect(holder.reload().ok).toBe(true);
    expect(holder.lastError).toBeNull();
    expect(effectiveDecision(run(holder.set, send))).toBe("deny");
  });

  it("leaves the set unchanged and throws when loading fails for a reason other than the rules", () => {
    writeOwner("alice", allowSends);
    let fail = false;
    const holder = new RulesHolder(paths, (p) => {
      if (fail) throw new Error("disk on fire");
      return loadRuleSet(p);
    });
    holder.reload();
    const good = holder.set;
    fail = true;
    expect(() => holder.reload()).toThrow("disk on fire");
    expect(holder.set).toBe(good);
  });
});

describe("watchRules", () => {
  let watcher: RulesWatcher | null = null;

  afterEach(() => {
    watcher?.close();
    watcher = null;
  });

  /** Starts watching and returns a function that resolves with the next reload. */
  function watching(holder: RulesHolder): () => Promise<ReloadOutcome> {
    const pending: ((outcome: ReloadOutcome) => void)[] = [];
    const errors: unknown[] = [];
    watcher = watchRules(holder, {
      debounceMs: 20,
      onReload: (outcome) => pending.shift()?.(outcome),
      onError: (error) => errors.push(error),
    });
    return () =>
      new Promise((resolve, reject) => {
        if (errors.length > 0) reject(errors[0]);
        else pending.push(resolve);
      });
  }

  it("reloads when an owner file changes", async () => {
    writeOwner("alice", allowSends);
    const holder = new RulesHolder(paths);
    holder.reload();
    const next = watching(holder);

    const reloaded = next();
    writeOwner("alice", oneRule("{ action: email.send }", "deny"));
    expect((await reloaded).ok).toBe(true);
    expect(effectiveDecision(run(holder.set, send))).toBe("deny");
  });

  it("keeps the last good set when an edit on disk is invalid", async () => {
    writeOwner("alice", allowSends);
    const holder = new RulesHolder(paths);
    holder.reload();
    const good = holder.set;
    const next = watching(holder);

    const reloaded = next();
    writeOwner("alice", "rules:\n  - match: {}\n    then: maybe\n");
    const outcome = await reloaded;
    expect(outcome).toMatchObject({ ok: false, keptLastGood: true });
    if (outcome.ok) throw new Error("expected an invalid reload");
    expect(outcome.error.issues[0]).toMatchObject({
      file: join(paths.ownersDir, "alice.yaml"),
      line: 3,
    });
    expect(holder.set).toBe(good);
  });

  it("follows an editor's save-by-rename and an org file edit", async () => {
    writeOwner("alice", allowSends);
    const holder = new RulesHolder(paths);
    holder.reload();
    const next = watching(holder);

    let reloaded = next();
    const temp = join(paths.ownersDir, ".alice.yaml.tmp");
    writeFileSync(temp, oneRule("{ action: email.send }", "ask"));
    renameSync(temp, join(paths.ownersDir, "alice.yaml"));
    expect((await reloaded).ok).toBe(true);
    expect(run(holder.set, send).verdict.decision).toBe("ask");

    reloaded = next();
    writeOrg(oneRule("{ action: email.send }", "deny"));
    expect((await reloaded).ok).toBe(true);
    expect(run(holder.set, send).verdict).toMatchObject({
      decision: "deny",
      rule: { layer: "org" },
    });
  });

  it("picks up a rules/ directory created after heel started", async () => {
    const holder = new RulesHolder(paths);
    holder.reload();
    const next = watching(holder);

    let reloaded = next();
    mkdirSync(paths.ownersDir);
    await reloaded;

    reloaded = next();
    writeOwner("alice", allowSends);
    expect((await reloaded).ok).toBe(true);
    expect(effectiveDecision(run(holder.set, send))).toBe("allow");
  });
});
