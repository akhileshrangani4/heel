import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { proposeRules } from "../../src/proposals/rules.ts";
import { listRuleChanges, noticeRuleFiles } from "../../src/store/rule-changes.ts";
import { ruleChanges } from "../../src/store/schema.ts";
import { attribute, humanPlaneHarness } from "../helpers/human-plane.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Roadmap 2.4: every change to a rules file is recorded: one added from a
 * proposal with who proposed it and who added it, and one made outside heel,
 * noticed on reload. The Rule history page shows them.
 */

const START = "rules:\n  - name: asks\n    match: {}\n    then: ask\n";

function setUp() {
  const home = tempDir("heel-history-");
  const paths = rulesPaths(home);
  mkdirSync(paths.ownersDir);
  const file = join(paths.ownersDir, "owner.yaml");
  writeFileSync(file, START);
  const h = humanPlaneHarness({ rulesHome: home });
  const notice = () => noticeRuleFiles(h.t.db, h.t.orgId, paths, h.clock.now);
  return { h, file, paths, notice };
}

describe("rule history (2.4)", () => {
  it("remembers a file the first time, then records each change made outside heel, once", () => {
    const { h, file, notice } = setUp();
    notice();
    expect(h.t.db.select().from(ruleChanges).all()).toEqual([]);

    writeFileSync(file, START.replace("then: ask", "then: deny"));
    notice();
    notice(); // Nothing new the second time.
    const [change, ...rest] = listRuleChanges(h.t.db, h.t.orgId, null);
    expect(rest).toEqual([]);
    expect(change).toMatchObject({ source: "outside", file: "rules/owner.yaml", agent: null });
    expect(change?.diff).toContain("-     then: ask");
    expect(change?.diff).toContain("+     then: deny");

    rmSync(file);
    notice();
    notice();
    expect(listRuleChanges(h.t.db, h.t.orgId, null)).toHaveLength(2);
  });

  it("records an added proposal with who proposed and added it, and not again on reload", async () => {
    const { h, notice } = setUp();
    notice();
    const proposed = proposeRules(
      h.t.db,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
      {
        rules: [
          {
            // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
            rule: { name: "read-mail", match: { action: "email.read" }, then: "allow" },
            why: "so I can summarise your inbox",
          },
        ],
      },
      h.clock.now,
    );
    if (!proposed.ok) throw new Error(proposed.problems.join("; "));
    const id = proposed.proposalId;
    const owner = await h.signIn(await h.enroll());
    const added = await h.ceremony(
      owner,
      {
        url: "/proposals/challenge",
        body: {
          proposalId: id,
          sha: attribute(
            await (await h.fetch(`/proposals/${id}`, { as: owner })).text(),
            "data-sha",
          ),
        },
      },
      "/proposals/confirm",
    );
    expect(added.status).toBe(200);
    notice(); // The reload heel's own write sets off.
    const changes = listRuleChanges(h.t.db, h.t.orgId, [h.t.ownerId]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      source: "proposal",
      proposalId: id,
      agent: h.agent.agentName,
      origin: "agent",
      decidedBy: expect.any(String),
    });
    expect(changes[0]?.diff).toContain("+   - name: read-mail");

    const page = await (await h.fetch("/rules/history", { as: owner })).text();
    expect(page).toContain("Rule history");
    expect(page).toContain(`from what ${h.agent.agentName} proposed`);
    expect(page).toContain(`/proposals/${id}`);
  });

  it("shows a member only their own file's changes", async () => {
    const { h, paths, notice } = setUp();
    h.addUser("sam", "member");
    const samFile = join(paths.ownersDir, "sam.yaml");
    writeFileSync(samFile, START);
    notice();
    writeFileSync(join(paths.ownersDir, "owner.yaml"), START.replace("ask", "deny"));
    notice();
    const sam = await h.signIn(await h.enroll("sam"));
    const page = await (await h.fetch("/rules/history", { as: sam })).text();
    expect(page).toContain("No changes yet.");
    expect(page).not.toContain("rules/owner.yaml");
  });
});
