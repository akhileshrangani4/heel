import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { findProposal, proposeRules } from "../../src/proposals/rules.ts";
import { humanPlaneHarness, issued, PUBLIC_URL } from "../helpers/human-plane.ts";
import { tempDir } from "../helpers/store.ts";

/** Proposed rules on the human plane (roadmap 2.1): only their owner sees and adds them. */

function setUp() {
  const home = tempDir("heel-proposal-routes-");
  const dir = rulesPaths(home).ownersDir;
  mkdirSync(dir);
  const file = join(dir, "owner.yaml");
  writeFileSync(file, "rules:\n  - name: asks\n    match: {}\n    then: ask\n");
  const h = humanPlaneHarness({ rulesHome: home });
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
  return { h, file, id: proposed.proposalId };
}

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

describe("proposed rules on the approval page", () => {
  it("the owner sees them on Approvals and adds them with a passkey", async () => {
    const { h, file, id } = setUp();
    const owner = await h.signIn(await h.enroll());
    expect(await (await h.fetch("/approvals", { as: owner })).text()).toContain("proposes");
    const page = await (await h.fetch(`/proposals/${id}`, { as: owner })).text();
    expect(page).toContain("so I can summarise your inbox");
    const added = await h.ceremony(
      owner,
      { url: "/proposals/challenge", body: { proposalId: id } },
      "/proposals/confirm",
    );
    expect(added.status).toBe(200);
    expect(readFileSync(file, "utf8")).toContain("read-mail");
    expect(findProposal(h.t.db, h.t.orgId, id)?.status).toBe("applied");
  });

  it("writes nothing when the file changed after the passkey challenge", async () => {
    const { h, file, id } = setUp();
    const owner = await h.signIn(await h.enroll());
    const challenge = await h.fetch("/proposals/challenge", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: id }),
    });
    const { challengeId, options } = await issued(challenge);
    writeFileSync(file, "rules:\n  - name: denies\n    match: {}\n    then: deny\n");
    const confirmed = await h.fetch("/proposals/confirm", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        challengeId,
        response: owner.authenticator.assert(options, PUBLIC_URL.origin),
      }),
    });
    expect(confirmed.status).toBe(409);
    expect(readFileSync(file, "utf8")).not.toContain("read-mail");
    expect(findProposal(h.t.db, h.t.orgId, id)?.status).toBe("pending");
  });

  it("someone else can't see, add or reject them", async () => {
    const { h, id } = setUp();
    h.addUser("sam", "admin");
    const sam = await h.signIn(await h.enroll("sam"));
    expect((await h.fetch(`/proposals/${id}`, { as: sam })).status).toBe(404);
    expect(await (await h.fetch("/approvals", { as: sam })).text()).not.toContain("proposes");
    const added = await h.ceremony(
      sam,
      { url: "/proposals/challenge", body: { proposalId: id } },
      "/proposals/confirm",
    );
    expect(added.status).toBe(404);
    const rejected = await h.fetch(`/proposals/${id}/reject`, {
      as: sam,
      ...form({ csrf: sam.csrf }),
    });
    expect(rejected.status).toBe(404);
    expect(findProposal(h.t.db, h.t.orgId, id)?.status).toBe("pending");
  });

  it("the owner rejects them with a plain form", async () => {
    const { h, file, id } = setUp();
    const owner = await h.signIn(await h.enroll());
    const rejected = await h.fetch(`/proposals/${id}/reject`, {
      as: owner,
      ...form({ csrf: owner.csrf }),
    });
    expect(rejected.status).toBe(303);
    expect(findProposal(h.t.db, h.t.orgId, id)?.status).toBe("rejected");
    expect(readFileSync(file, "utf8")).not.toContain("read-mail");
  });
});
