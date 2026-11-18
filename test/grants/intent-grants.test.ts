import { describe, expect, it } from "vitest";
import { compileGrant, GrantError } from "../../src/grants/compile.ts";
import { createGrant, revokeGrant } from "../../src/store/grants.ts";
import { approvalHarness, SEND } from "../helpers/approvals.ts";
import { oneRule } from "../helpers/pipeline.ts";

/**
 * Intent grants (A4b): a narrow allow a person signed for one agent and one
 * task, enforced above the owner's rules and below the org's.
 */

const ASK_SENDS = oneRule("{ action: email.send }", "ask");
const VENDOR_ONLY = "{ action: email.send, recipients: { all_domain_in: [vendor.com] } }";

function grant(h: ReturnType<typeof approvalHarness>, match: string, expiresInMs = 3_600_000) {
  return createGrant(h.t.db, {
    orgId: h.t.orgId,
    agentId: h.agent.agentId,
    task: "Send the Q3 numbers to the vendor",
    match,
    by: h.t.ownerId,
    now: h.clock.now,
    expiresAt: new Date(h.clock.now.getTime() + expiresInMs),
  });
}

describe("compileGrant", () => {
  it("compiles one match into an allow named after the grant", () => {
    const rule = compileGrant(VENDOR_ONLY, { id: "grt_1" });
    expect(rule.decision).toBe("allow");
    expect(rule.ref).toEqual({ name: "grant grt_1", file: "grants", line: 0 });
  });

  it.each([
    ["an empty match", "{}"],
    ["a list", "[a, b]"],
    ["an unknown key", "{ colour: red }"],
    ["broken YAML", "{ action: "],
  ])("refuses %s", (_, match) => {
    expect(() => compileGrant(match, { id: "grt_1" })).toThrow(GrantError);
  });
});

describe("intent grants in the pipeline", () => {
  it("allow what they name for their agent, and nothing else", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    grant(h, VENDOR_ONLY);
    expect(await h.call({ args: SEND })).toMatchObject({ status: "allowed" });
    expect(h.audit().at(-1)).toMatchObject({
      kind: "allow",
      rule: { name: expect.stringMatching(/^grant /) },
    });
    expect((await h.call({ args: { ...SEND, recipients: ["ceo@rival.com"] } })).status).toBe(
      "pending",
    );
    const other = h.addAgent("other-bot");
    expect((await h.call({ agent: other, args: SEND })).status).toBe("pending");
  });

  it("I-13: never get past an org deny", async () => {
    const h = approvalHarness({
      owner: ASK_SENDS,
      org: oneRule("{ action: email.send, recipients: { any_domain_in: [vendor.com] } }", "deny"),
    });
    grant(h, VENDOR_ONLY);
    expect(await h.call({ args: SEND })).toMatchObject({ status: "denied" });
  });

  it("end at expiry and when revoked", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = grant(h, VENDOR_ONLY, 60_000);
    expect((await h.call({ args: SEND })).status).toBe("allowed");
    h.clock.advance(61_000);
    expect((await h.call({ args: SEND })).status).toBe("pending");

    const second = grant(h, VENDOR_ONLY);
    expect((await h.call({ args: { ...SEND, subject: "again" } })).status).toBe("allowed");
    expect(revokeGrant(h.t.db, h.t.orgId, second, h.t.ownerId, h.clock.now)).toBe(true);
    expect((await h.call({ args: { ...SEND, subject: "third" } })).status).toBe("pending");
    expect(id).not.toBe(second);
  });
});
