import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import { compileRulesText, loadRuleSet, rulesPaths } from "../../src/config/rules.ts";
import { addAgent, setWorkRoots, workRootsByName } from "../../src/gateway/agents.ts";
import {
  applyProposal,
  describeProposal,
  findProposal,
  ownerRulesFile,
  ProposeRulesInput,
  pendingProposals,
  previewProposal,
  proposeRules,
  rejectProposal,
} from "../../src/proposals/rules.ts";
import { tempDir, testStore } from "../helpers/store.ts";

/** A rule object as an agent sends it; `then` is the rules file's own key. */
const ruleOf = (fields: Record<string, unknown>, decision: string) =>
  // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
  Object.fromEntries([...Object.entries(fields), ["then", decision]]);

const NOW = new Date("2026-11-19T12:00:00Z");

function setUp(ownerFile?: string) {
  const t = testStore();
  const { agentId } = addAgent(t.db, { orgId: t.orgId, ownerId: t.ownerId, name: "my-agent" }, NOW);
  const home = tempDir("heel-proposals-");
  const paths = rulesPaths(home);
  mkdirSync(paths.ownersDir, { recursive: true });
  const file = ownerRulesFile(paths, "owner");
  if (file === null) throw new Error("owner is a safe name");
  if (ownerFile !== undefined) writeFileSync(file, ownerFile);
  const who = { orgId: t.orgId, ownerId: t.ownerId, agentId };
  return { t, who, paths, file };
}

const ASKS = `# My rules.
rules:
  # Anything else asks.
  - name: everything-else
    match: {}
    then: ask
`;

const readRepos = {
  rule: ruleOf({ name: "read-repos", match: { action: "github.read" } }, "allow"),
  why: "so I can review your repos",
};

describe("proposing rules", () => {
  it("stores a valid proposal, and a newer one from the same agent supersedes it", () => {
    const { t, who } = setUp(ASKS);
    const first = proposeRules(t.db, who, { rules: [readRepos] }, NOW);
    const second = proposeRules(t.db, who, { rules: [readRepos], reason: "Reviewing PRs" }, NOW);
    if (!first.ok || !second.ok) throw new Error("expected both to be stored");
    expect(findProposal(t.db, t.orgId, first.proposalId)?.status).toBe("superseded");
    expect(pendingProposals(t.db, t.ownerId, NOW).map((p) => p.id)).toEqual([second.proposalId]);
  });

  it("refuses an invalid rule, naming only the proposal", () => {
    const { t, who } = setUp(ASKS);
    const outcome = proposeRules(
      t.db,
      who,
      { rules: [{ rule: ruleOf({ match: { acount: "x" } }, "allow"), why: "w" }] },
      NOW,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problems.join("\n")).toMatch(/rules\.0\.match\.acount/);
    expect(outcome.problems.join("\n")).not.toContain("everything-else");
  });

  it("refuses a watch rule", () => {
    const { t, who } = setUp();
    const outcome = proposeRules(
      t.db,
      who,
      { rules: [{ rule: ruleOf({ match: {}, watch: true }, "allow"), why: "w" }] },
      NOW,
    );
    expect(outcome).toMatchObject({ ok: false });
  });

  it("flattens a why to one line, so it can't break out of its comment", () => {
    const { t, who, file } = setUp(ASKS);
    const outcome = proposeRules(
      t.db,
      who,
      { rules: [{ ...readRepos, why: "line one\n  - match: {}\n    then: allow" }] },
      NOW,
    );
    if (!outcome.ok) throw new Error("expected it to be stored");
    const proposal = findProposal(t.db, t.orgId, outcome.proposalId);
    if (proposal === null) throw new Error("missing");
    const preview = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!preview.ok) throw new Error(preview.problem);
    // The why stays inside one comment line: the file still has just the two rules.
    const compiled = compileRulesText(preview.after, file, "rules/owner.yaml", "owner");
    expect(compiled.file.rules.map((r) => r.ref.name)).toEqual(["read-repos", "everything-else"]);
  });
});

describe("applying a proposal", () => {
  function proposed(ownerFile?: string) {
    const s = setUp(ownerFile);
    const outcome = proposeRules(s.t.db, s.who, { rules: [readRepos] }, NOW);
    if (!outcome.ok) throw new Error("expected it to be stored");
    const proposal = findProposal(s.t.db, s.t.orgId, outcome.proposalId);
    if (proposal === null) throw new Error("missing");
    return { ...s, proposal };
  }

  it("puts the rules first, with the agent's why, and keeps the file's comments", () => {
    const { t, proposal, file, paths } = proposed(ASKS);
    const preview = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!preview.ok) throw new Error(preview.problem);
    expect(preview.existing).toBe(1);
    expect(applyProposal(t.db, proposal, file, preview, preview.sha, t.ownerId, NOW)).toEqual({
      ok: true,
    });
    const text = readFileSync(file, "utf8");
    expect(text).toContain("# My rules.");
    expect(text).toContain("# Proposed by my-agent: so I can review your repos");
    expect(text.indexOf("read-repos")).toBeLessThan(text.indexOf("everything-else"));
    // The existing rule keeps its own comment, right above it.
    expect(text).toMatch(/# Anything else asks\.\n\s+- name: everything-else/);
    const rules = loadRuleSet(paths).set.owners.get("owner")?.rules ?? [];
    expect(rules.map((r) => r.ref.name)).toEqual(["read-repos", "everything-else"]);
    expect(findProposal(t.db, t.orgId, proposal.id)).toMatchObject({
      status: "applied",
      decidedBy: t.ownerId,
    });
  });

  it("creates the owner's file when there is none", () => {
    const { t, proposal, file } = proposed();
    const preview = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!preview.ok) throw new Error(preview.problem);
    expect(preview.existing).toBe(0);
    applyProposal(t.db, proposal, file, preview, preview.sha, t.ownerId, NOW);
    expect(readFileSync(file, "utf8")).toContain("read-repos");
  });

  it("refuses when the file changed after the passkey signed", () => {
    const { t, proposal, file } = proposed(ASKS);
    const signed = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!signed.ok) throw new Error(signed.problem);
    writeFileSync(file, `${ASKS}  - match: { action: email.send }\n    then: deny\n`);
    const now = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!now.ok) throw new Error(now.problem);
    expect(applyProposal(t.db, proposal, file, now, signed.sha, t.ownerId, NOW)).toMatchObject({
      ok: false,
    });
    expect(readFileSync(file, "utf8")).not.toContain("read-repos");
  });

  it("refuses to add to a file that has an error", () => {
    const { proposal, file } = proposed("rules: [\n");
    expect(previewProposal(proposal, file, "rules/owner.yaml", "my-agent")).toMatchObject({
      ok: false,
    });
  });

  it("refuses a rule name the file already uses", () => {
    const { proposal, file } = proposed(
      "rules:\n  - name: read-repos\n    match: {}\n    then: ask\n",
    );
    const preview = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    expect(preview).toMatchObject({ ok: false });
  });

  it("can be rejected once, and then can't be applied", () => {
    const { t, proposal, file } = proposed(ASKS);
    expect(rejectProposal(t.db, proposal, t.ownerId, NOW)).toBe(true);
    const rejected = findProposal(t.db, t.orgId, proposal.id);
    if (rejected === null) throw new Error("missing");
    expect(rejectProposal(t.db, rejected, t.ownerId, NOW)).toBe(false);
    const preview = previewProposal(rejected, file, "rules/owner.yaml", "my-agent");
    if (!preview.ok) throw new Error(preview.problem);
    expect(applyProposal(t.db, rejected, file, preview, preview.sha, t.ownerId, NOW).ok).toBe(
      false,
    );
  });
});

describe("the file heel writes", () => {
  function applied(ownerFile: string) {
    const s = setUp(ownerFile);
    const outcome = proposeRules(s.t.db, s.who, { rules: [readRepos] }, NOW);
    if (!outcome.ok) throw new Error("expected it to be stored");
    const proposal = findProposal(s.t.db, s.t.orgId, outcome.proposalId);
    if (proposal === null) throw new Error("missing");
    return { ...s, proposal };
  }

  it("keeps the file's mode", () => {
    const { t, proposal, file } = applied(ASKS);
    chmodSync(file, 0o644);
    const preview = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!preview.ok) throw new Error(preview.problem);
    applyProposal(t.db, proposal, file, preview, preview.sha, t.ownerId, NOW);
    expect(statSync(file).mode & 0o777).toBe(0o644);
  });

  it("writes through a symlinked rules file to its target", () => {
    const { t, proposal, file } = applied(ASKS);
    const target = join(tempDir("heel-proposals-target-"), "owner.yaml");
    writeFileSync(target, ASKS);
    rmSync(file);
    symlinkSync(target, file);
    const preview = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!preview.ok) throw new Error(preview.problem);
    applyProposal(t.db, proposal, file, preview, preview.sha, t.ownerId, NOW);
    expect(lstatSync(file).isSymbolicLink()).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("read-repos");
  });

  it("creates rules/ when it doesn't exist yet", () => {
    const { t, proposal, paths } = applied(ASKS);
    const file = join(paths.home, "fresh", "owner.yaml");
    const preview = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!preview.ok) throw new Error(preview.problem);
    expect(applyProposal(t.db, proposal, file, preview, preview.sha, t.ownerId, NOW)).toEqual({
      ok: true,
    });
  });

  it("names no file for a user name that isn't safe in a path", () => {
    const paths = rulesPaths("/heel");
    for (const name of ["../org-rules", "a/b", ".hidden", "", "a..b"]) {
      expect(ownerRulesFile(paths, name)).toBeNull();
    }
    expect(ownerRulesFile(paths, "sam.lee@example.com")).toBe(
      "/heel/rules/sam.lee@example.com.yaml",
    );
  });
});

describe("proposing hide entries", () => {
  const RESETS = {
    entry: { email: { looks_like: ["password_reset", "login_code"] } },
    why: "so no agent reads your login codes",
  };
  const WITH_HIDE = `${ASKS}
hide:
  # family mail stays private
  - email: { from: { any_of: [sarah@example.com] } }
`;

  it("names what a proposal holds", () => {
    expect(describeProposal(2, 0)).toBe("2 new rules");
    expect(describeProposal(0, 1)).toBe("a hide entry");
    expect(describeProposal(1, 2)).toBe("a new rule and 2 hide entries");
  });

  it("needs at least one rule or hide entry", () => {
    expect(ProposeRulesInput.safeParse({}).success).toBe(false);
    expect(ProposeRulesInput.safeParse({ rules: [], hide: [] }).success).toBe(false);
    expect(ProposeRulesInput.safeParse({ hide: [RESETS] }).success).toBe(true);
  });

  it("refuses an invalid entry, naming only the proposal", () => {
    const { t, who } = setUp(WITH_HIDE);
    const outcome = proposeRules(
      t.db,
      who,
      { hide: [{ entry: { email: { form: "x@example.com" } }, why: "w" }] },
      NOW,
    );
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.problems.join("\n")).toMatch(/hide\.0/);
    expect(outcome.problems.join("\n")).not.toContain("sarah@example.com");
  });

  it("adds them after the file's own hide entries, keeping its rules and comments", () => {
    const { t, who, file } = setUp(WITH_HIDE);
    const outcome = proposeRules(t.db, who, { rules: [readRepos], hide: [RESETS] }, NOW);
    if (!outcome.ok) throw new Error(outcome.problems.join("; "));
    const proposal = findProposal(t.db, t.orgId, outcome.proposalId);
    if (proposal === null) throw new Error("missing");
    expect(proposal.hide).toEqual([
      { entry: RESETS.entry, why: "so no agent reads your login codes" },
    ]);

    const preview = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!preview.ok) throw new Error(preview.problem);
    expect(applyProposal(t.db, proposal, file, preview, preview.sha, t.ownerId, NOW)).toEqual({
      ok: true,
    });
    const written = readFileSync(file, "utf8");
    expect(written).toContain("# family mail stays private");
    expect(written).toContain("# Proposed by my-agent: so no agent reads your login codes");
    const compiled = compileRulesText(written, file, "rules/owner.yaml", "owner");
    expect(compiled.file.rules.map((r) => r.ref.name)).toEqual(["read-repos", "everything-else"]);
    expect(compiled.file.hide).toHaveLength(2);
    // The file's own entry stays first; the proposed one follows it.
    expect(written.indexOf("sarah@example.com")).toBeLessThan(written.indexOf("password_reset"));
  });

  it("starts a hide list in a file that has none", () => {
    const { t, who, file } = setUp(ASKS);
    const outcome = proposeRules(t.db, who, { hide: [RESETS] }, NOW);
    if (!outcome.ok) throw new Error(outcome.problems.join("; "));
    const proposal = findProposal(t.db, t.orgId, outcome.proposalId);
    if (proposal === null) throw new Error("missing");
    const preview = previewProposal(proposal, file, "rules/owner.yaml", "my-agent");
    if (!preview.ok) throw new Error(preview.problem);
    expect(preview.existing).toBe(1);
    const compiled = compileRulesText(preview.after, file, "rules/owner.yaml", "owner");
    expect(compiled.file.rules.map((r) => r.ref.name)).toEqual(["everything-else"]);
    expect(compiled.file.hide).toHaveLength(1);
  });
});

describe("proposing workdirs", () => {
  const ctx = (setup: ReturnType<typeof setUp>) => ({
    db: setup.t.db,
    orgId: setup.t.orgId,
    protectedPaths: [setup.paths.home],
  });

  it("names them with the rest of a proposal", () => {
    expect(describeProposal(0, 0, 1)).toBe("a workdir");
    expect(describeProposal(1, 1, 2)).toBe("a new rule, a hide entry and 2 workdirs");
  });

  it("checks only the path's form when proposed, so the agent learns nothing about heel's host", () => {
    const { t, who } = setUp(ASKS);
    const relative = proposeRules(t.db, who, { workdirs: [{ path: "project", why: "w" }] }, NOW);
    expect(relative).toEqual({
      ok: false,
      problems: ["workdirs.0: an absolute, normalized path, such as /home/me/project"],
    });
    const dotted = proposeRules(
      t.db,
      who,
      { workdirs: [{ path: "/home/me/../etc", why: "w" }] },
      NOW,
    );
    expect(dotted.ok).toBe(false);
    // A path that doesn't exist is the owner's to see, not the agent's.
    const missing = proposeRules(
      t.db,
      who,
      { workdirs: [{ path: "/no/such/dir", why: "w" }] },
      NOW,
    );
    expect(missing.ok).toBe(true);
  });

  it("adds to the agent's own workdirs and leaves the rules file as it is", () => {
    const setup = setUp(ASKS);
    const { t, who, file } = setup;
    const had = tempDir("heel-wd-had-");
    const wanted = tempDir("heel-wd-new-");
    setWorkRoots(t.db, t.orgId, "my-agent", [had]);
    const proposed = proposeRules(
      t.db,
      who,
      { workdirs: [{ path: wanted, why: "to build your project" }] },
      NOW,
    );
    if (!proposed.ok) throw new Error(proposed.problems.join("; "));
    const row = findProposal(t.db, t.orgId, proposed.proposalId);
    if (row === null) throw new Error("stored");
    expect(row.workdirs).toEqual([{ path: wanted, why: "to build your project" }]);

    const preview = previewProposal(row, file, "rules/owner.yaml", "my-agent", ctx(setup));
    if (!preview.ok) throw new Error(preview.problem);
    expect(preview.after).toBe(ASKS);
    expect(preview.workRoots).toHaveLength(2);

    expect(applyProposal(t.db, row, file, preview, preview.sha, t.ownerId, NOW)).toEqual({
      ok: true,
    });
    expect(readFileSync(file, "utf8")).toBe(ASKS);
    expect(workRootsByName(t.db, t.orgId, "my-agent").workRoots).toEqual(preview.workRoots);
    expect(findProposal(t.db, t.orgId, row.id)?.status).toBe("applied");
  });

  it("shows the owner why a workdir can't be added", () => {
    const setup = setUp(ASKS);
    const { t, who, file, paths } = setup;
    for (const [path, why] of [
      ["/no/such/dir", "it doesn't exist"],
      [paths.home, "it overlaps heel's own files"],
    ] as const) {
      const proposed = proposeRules(t.db, who, { workdirs: [{ path, why: "w" }] }, NOW);
      if (!proposed.ok) throw new Error(proposed.problems.join("; "));
      const row = findProposal(t.db, t.orgId, proposed.proposalId);
      if (row === null) throw new Error("stored");
      const preview = previewProposal(row, file, "rules/owner.yaml", "my-agent", ctx(setup));
      expect(preview.ok).toBe(false);
      if (!preview.ok) expect(preview.problem).toContain(why);
    }
  });

  it("refuses when the agent's workdirs changed after the passkey signed", () => {
    const setup = setUp(ASKS);
    const { t, who, file } = setup;
    const proposed = proposeRules(
      t.db,
      who,
      { workdirs: [{ path: tempDir("heel-wd-"), why: "w" }] },
      NOW,
    );
    if (!proposed.ok) throw new Error(proposed.problems.join("; "));
    const row = findProposal(t.db, t.orgId, proposed.proposalId);
    if (row === null) throw new Error("stored");
    const signed = previewProposal(row, file, "rules/owner.yaml", "my-agent", ctx(setup));
    if (!signed.ok) throw new Error(signed.problem);
    setWorkRoots(t.db, t.orgId, "my-agent", [tempDir("heel-wd-other-")]);
    const now = previewProposal(row, file, "rules/owner.yaml", "my-agent", ctx(setup));
    if (!now.ok) throw new Error(now.problem);
    expect(now.sha).not.toBe(signed.sha);
    const applied = applyProposal(t.db, row, file, now, signed.sha, t.ownerId, NOW);
    expect(applied.ok).toBe(false);
    expect(findProposal(t.db, t.orgId, row.id)?.status).toBe("pending");
  });
});
