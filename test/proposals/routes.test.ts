import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { workRootsByName } from "../../src/gateway/agents.ts";
import { findProposal, proposeRules } from "../../src/proposals/rules.ts";
import { attribute, humanPlaneHarness, issued, PUBLIC_URL } from "../helpers/human-plane.ts";
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
    expect(await (await h.fetch("/approvals", { as: owner })).text()).toContain("wants to add");
    const page = await (await h.fetch(`/proposals/${id}`, { as: owner })).text();
    expect(page).toContain("so I can summarise your inbox");
    // What the rule does, in words, from the rule itself (roadmap 2.3).
    expect(page).toContain(
      "Any of your agents may read email on any of your accounts without asking you.",
    );
    // A crafted link can't make a pending proposal look added or rejected.
    for (const crafted of ["applied", "rejected"]) {
      const shown = await (await h.fetch(`/proposals/${id}?${crafted}`, { as: owner })).text();
      expect(shown).not.toContain("heel is using them now");
      expect(shown).not.toContain("rules weren't added");
    }
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
    expect(readFileSync(file, "utf8")).toContain("read-mail");
    expect(findProposal(h.t.db, h.t.orgId, id)?.status).toBe("applied");
    expect(await (await h.fetch(`/proposals/${id}?applied`, { as: owner })).text()).toContain(
      "heel is using them now",
    );
  });

  it("writes nothing when the file changed after the passkey challenge", async () => {
    const { h, file, id } = setUp();
    const owner = await h.signIn(await h.enroll());
    const challenge = await h.fetch("/proposals/challenge", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        proposalId: id,
        sha: attribute(await (await h.fetch(`/proposals/${id}`, { as: owner })).text(), "data-sha"),
      }),
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

  it("refuses to sign a file that changed after the page was shown", async () => {
    const { h, file, id } = setUp();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/proposals/${id}`, { as: owner })).text();
    const sha = attribute(page, "data-sha");
    writeFileSync(file, "rules:\n  - name: denies\n    match: {}\n    then: deny\n");
    const challenge = await h.fetch("/proposals/challenge", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: id, sha }),
    });
    expect(challenge.status).toBe(409);
    expect(readFileSync(file, "utf8")).not.toContain("read-mail");
  });

  it("shows the agent's text as text", async () => {
    const { h } = setUp();
    const hostile = "<img src=x onerror=alert(1)>";
    const proposed = proposeRules(
      h.t.db,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
      {
        reason: hostile,
        rules: [
          {
            // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
            rule: { name: "x-rule", match: { tool: hostile }, then: "allow" },
            why: hostile,
          },
        ],
      },
      h.clock.now,
    );
    if (!proposed.ok) throw new Error(proposed.problems.join("; "));
    const owner = await h.signIn(await h.enroll());
    const list = await (await h.fetch("/approvals", { as: owner })).text();
    const page = await (await h.fetch(`/proposals/${proposed.proposalId}`, { as: owner })).text();
    for (const html of [list, page]) {
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x");
    }
  });

  it("someone else can't see, add or reject them", async () => {
    const { h, id } = setUp();
    h.addUser("sam", "admin");
    const sam = await h.signIn(await h.enroll("sam"));
    expect((await h.fetch(`/proposals/${id}`, { as: sam })).status).toBe(404);
    expect(await (await h.fetch("/approvals", { as: sam })).text()).not.toContain("wants to add");
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

describe("proposed hide entries on the approval page", () => {
  it("shows them in their own section, says hiding only takes email away, and adds them", async () => {
    const { h, file } = setUp();
    const proposed = proposeRules(
      h.t.db,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
      {
        hide: [
          {
            entry: { email: { looks_like: ["login_code"] } },
            why: "so no agent reads your login codes",
          },
        ],
      },
      h.clock.now,
    );
    if (!proposed.ok) throw new Error(proposed.problems.join("; "));
    const owner = await h.signIn(await h.enroll());
    const listed = await (await h.fetch("/approvals", { as: owner })).text();
    expect(listed).toContain("a hide entry");
    const page = await (await h.fetch(`/proposals/${proposed.proposalId}`, { as: owner })).text();
    expect(page).toContain("Hide from agents");
    expect(page).toContain("login_code");
    expect(page).toContain("Hiding only takes email away from your agents");
    expect(page).toContain("Add to the hide list");

    const added = await h.ceremony(
      owner,
      {
        url: "/proposals/challenge",
        body: { proposalId: proposed.proposalId, sha: attribute(page, "data-sha") },
      },
      "/proposals/confirm",
    );
    expect(added.status).toBe(200);
    expect(readFileSync(file, "utf8")).toContain("login_code");
    expect(findProposal(h.t.db, h.t.orgId, proposed.proposalId)?.status).toBe("applied");
  });
});

describe("proposed workdirs on the approval page", () => {
  it("says in plain words where the agent's heel run may work, and adds it with a passkey", async () => {
    const { h, file } = setUp();
    const before = readFileSync(file, "utf8");
    const project = tempDir("heel-wd-project-");
    const proposed = proposeRules(
      h.t.db,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
      { workdirs: [{ path: project, why: "to run your test suite" }] },
      h.clock.now,
    );
    if (!proposed.ok) throw new Error(proposed.problems.join("; "));
    const owner = await h.signIn(await h.enroll());
    const listed = await (await h.fetch("/approvals", { as: owner })).text();
    expect(listed).toContain("a workdir");
    expect(listed).toContain("for its heel run");
    const page = await (await h.fetch(`/proposals/${proposed.proposalId}`, { as: owner })).text();
    expect(page).toContain("Workdirs for heel run");
    expect(page).toContain("may run commands with heel run in");
    expect(page).toContain(project);
    expect(page).toContain("to run your test suite");
    expect(page).toContain("Add this workdir");
    expect(page).not.toContain("The file after the change");

    const added = await h.ceremony(
      owner,
      {
        url: "/proposals/challenge",
        body: { proposalId: proposed.proposalId, sha: attribute(page, "data-sha") },
      },
      "/proposals/confirm",
    );
    expect(added.status).toBe(200);
    expect(readFileSync(file, "utf8")).toBe(before);
    const roots = workRootsByName(h.t.db, h.t.orgId, h.agent.agentName).workRoots;
    expect(roots).toHaveLength(1);
    const done = await (
      await h.fetch(`/proposals/${proposed.proposalId}?applied`, { as: owner })
    ).text();
    expect(done).toContain("heel run can work there now");
  });

  it("shows the folder heel would store, when the agent's path is a symlink to another one", async () => {
    const { h } = setUp();
    const real = realpathSync(tempDir("heel-wd-real-"));
    const link = join(tempDir("heel-wd-links-"), "looks-harmless");
    symlinkSync(real, link);
    const proposed = proposeRules(
      h.t.db,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, agentId: h.agent.agentId },
      { workdirs: [{ path: link, why: "to work there" }] },
      h.clock.now,
    );
    if (!proposed.ok) throw new Error(proposed.problems.join("; "));
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch(`/proposals/${proposed.proposalId}`, { as: owner })).text();
    expect(page).toContain(`may run commands with heel run in <code>${real}</code>`);
    expect(page).toContain(`asked for <code>${link}</code>, which leads to this`);
    await h.ceremony(
      owner,
      {
        url: "/proposals/challenge",
        body: { proposalId: proposed.proposalId, sha: attribute(page, "data-sha") },
      },
      "/proposals/confirm",
    );
    expect(workRootsByName(h.t.db, h.t.orgId, h.agent.agentName).workRoots).toEqual([real]);
  });
});
