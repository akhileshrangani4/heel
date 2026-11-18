import { describe, expect, it } from "vitest";
import { listGrants, liveGrants } from "../../src/store/grants.ts";
import { SEND } from "../helpers/approvals.ts";
import { humanPlaneHarness } from "../helpers/human-plane.ts";
import { oneRule } from "../helpers/pipeline.ts";

/** Signing and revoking intent grants on the human plane (A4b). */

const ASK_SENDS = oneRule("{ action: email.send }", "ask");
const MATCH = "{ action: email.send, recipients: { all_domain_in: [vendor.com] } }";

describe("the Grants page", () => {
  it("signs a grant with a passkey, and the agent's next matching call runs", async () => {
    const h = humanPlaneHarness({ owner: ASK_SENDS });
    const owner = await h.signIn(await h.enroll());
    const signed = await h.ceremony(
      owner,
      {
        url: "/grants/challenge",
        body: {
          agent: h.agent.agentId,
          task: "Send Q3 to the vendor",
          match: MATCH,
          duration: "1h",
        },
      },
      "/grants/confirm",
    );
    expect(signed.status).toBe(200);
    expect(liveGrants(h.t.db, h.t.orgId, h.agent.agentId, h.clock.now)).toHaveLength(1);
    expect(await h.call({ args: SEND })).toMatchObject({ status: "allowed" });
  });

  it("refuses a match that doesn't compile, and an agent that isn't yours", async () => {
    const h = humanPlaneHarness({ owner: ASK_SENDS });
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));
    const bad = await h.fetch("/grants/challenge", {
      as: sam,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: h.agent.agentId, task: "x", match: MATCH, duration: "1h" }),
    });
    expect(bad.status).toBe(403);

    const owner = await h.signIn(await h.enroll());
    const invalid = await h.fetch("/grants/challenge", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent: h.agent.agentId, task: "x", match: "{}", duration: "1h" }),
    });
    expect(invalid.status).toBe(400);
    expect(listGrants(h.t.db, h.t.orgId)).toEqual([]);
  });

  it("revokes with a plain form", async () => {
    const h = humanPlaneHarness({ owner: ASK_SENDS });
    const owner = await h.signIn(await h.enroll());
    await h.ceremony(
      owner,
      {
        url: "/grants/challenge",
        body: { agent: h.agent.agentId, task: "Send Q3", match: MATCH, duration: "1d" },
      },
      "/grants/confirm",
    );
    const [grant] = listGrants(h.t.db, h.t.orgId);
    const revoked = await h.fetch("/grants/revoke", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: owner.csrf, id: grant?.id ?? "" }).toString(),
    });
    expect(revoked.status).toBe(303);
    expect(liveGrants(h.t.db, h.t.orgId, h.agent.agentId, h.clock.now)).toEqual([]);
    expect((await h.call({ args: SEND })).status).toBe("pending");
  });
});
