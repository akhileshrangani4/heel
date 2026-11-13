import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { effectiveDecision } from "../../src/core/rules/evaluate.ts";
import type { RuleFacts } from "../../src/core/rules/facts.ts";
import { facts, ruleSet, run } from "./helpers.ts";

/**
 * The README's example rules and hide entries, read from README.md itself,
 * load unchanged and decide as the README describes.
 */

const ROOT = join(import.meta.dirname, "..", "..");

function readmeYamlBlocks(): string[] {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  return [...readme.matchAll(/```yaml\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
}

const blocks = readmeYamlBlocks();
const readmeRules = blocks.join("\n");
const set = ruleSet({ owner: readmeRules });
const decide = (call: RuleFacts, ctx: Parameters<typeof run>[2] = {}) =>
  run(set, call, ctx).verdict;
const ruleNumber = (call: RuleFacts, ctx: Parameters<typeof run>[2] = {}) => {
  const verdict = decide(call, ctx);
  return verdict.rule === null ? "default" : verdict.rule.index;
};

describe("README examples", () => {
  it("are a rules block and a hide block", () => {
    expect(blocks).toHaveLength(2);
    expect(blocks[0]?.startsWith("rules:\n")).toBe(true);
    expect(blocks[1]?.startsWith("hide:\n")).toBe(true);
  });

  it("load unchanged: ten rules and two hide entries", () => {
    const owner = set.owners.values().next().value;
    expect(owner?.rules).toHaveLength(10);
    expect(owner?.hide).toHaveLength(2);
  });

  it("are what the fixture for `heel rules test` holds", () => {
    const fixture = readFileSync(join(ROOT, "test/fixtures/rules/readme/rules/owner.yaml"), "utf8");
    for (const block of blocks) expect(fixture).toContain(block);
  });

  it("allow reads", () => {
    expect(ruleNumber(facts({ kind: "read", account: "gmail-personal" }))).toBe(1);
  });

  it("never email a client from the personal account", () => {
    const send = facts({
      account: "gmail-personal",
      action: "email.send",
      recipients: ["ceo@clientco.com", "me@company.com"],
    });
    expect(decide(send)).toMatchObject({ decision: "deny", rule: { index: 2 } });
  });

  it("let coworkers already in the thread through, and ask for everyone else", () => {
    const send = facts({ action: "email.send", recipients: ["bob@company.com"] });
    expect(ruleNumber(send, { state: () => "pass" })).toBe(3);
    expect(decide(send, { state: () => "fail" })).toMatchObject({
      decision: "ask",
      rule: { index: 4 },
    });
    const replyAll = facts({
      action: "email.send",
      recipients: ["bob@company.com", "buyer@customer.com"],
    });
    expect(decide(replyAll)).toMatchObject({ decision: "ask", rule: { index: 4 } });
  });

  it("deny when the thread lookup fails, rather than falling through to ask", () => {
    const send = facts({ action: "email.send", recipients: ["bob@company.com"] });
    expect(decide(send, { state: () => "unavailable" })).toMatchObject({
      decision: "deny",
      reason: "state_check_unavailable",
    });
  });

  it("count removed messages per run and per hour", () => {
    const remove = (items: number) => facts({ action: "email.remove", items, runId: "r1" });
    const counts = (run: number, hour: number) => ({
      counted: (_rule: unknown, per: "run" | "hour") => (per === "run" ? run : hour),
    });
    expect(ruleNumber(remove(1), counts(19, 19))).toBe(7);
    expect(ruleNumber(remove(1), counts(20, 20))).toBe(5);
    expect(ruleNumber(remove(500), counts(0, 0))).toBe(5);
    expect(ruleNumber(facts({ action: "email.remove", items: 1 }), counts(0, 100))).toBe(6);
  });

  it("merge only green PRs on the named repos", () => {
    const merge = (repo: string) => facts({ action: "github.merge", repo, account: "github" });
    expect(ruleNumber(merge("acme/web"), { state: () => "pass" })).toBe(8);
    expect(ruleNumber(merge("acme/web"), { state: () => "fail" })).toBe("default");
    // The repo doesn't match, so heel never looks the checks up.
    expect(ruleNumber(merge("acme/secret"))).toBe("default");
  });

  it("allow kubectl reads and ask for deletes", () => {
    const kubectl = (verb: string) =>
      facts({
        account: "k8s",
        cli: { command: "kubectl", verb, flags: {}, argv: ["kubectl", verb] },
      });
    expect(ruleNumber(kubectl("logs"))).toBe(9);
    expect(ruleNumber(kubectl("delete"))).toBe(10);
    expect(effectiveDecision(run(set, kubectl("apply")))).toBe("deny");
  });
});
