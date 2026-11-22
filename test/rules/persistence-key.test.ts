import { describe, expect, it } from "vitest";
import { facts, ruleSet, run } from "./helpers.ts";

/**
 * `persistence: false` (added for 2.10's suggestions): a rule that never
 * matches a call that outlives heel, and so never counts as naming one (I-70).
 */
const RULES = `rules:
  - name: sends-to-bob
    match: { action: email.send, recipients: { equals: [bob@work.com] }, persistence: false }
    then: allow
  - match: {}
    then: ask
`;

describe("the persistence match key", () => {
  it("matches an ordinary call and skips one that outlives heel", () => {
    const set = ruleSet({ owner: RULES });
    const send = facts({ action: "email.send", tool: "send_email", recipients: ["bob@work.com"] });
    expect(run(set, send).verdict).toMatchObject({ decision: "allow" });
    // A forwarding filter to bob is email.send too, but persistent: the rule doesn't match it,
    // and, naming nothing, it leaves the call denied as unnamed, as before the rule existed.
    const filter = { ...send, tool: "create_filter", persistence: true };
    expect(run(set, filter).verdict).toMatchObject({
      decision: "deny",
      reason: "persistence_unnamed",
    });
  });

  it("matches persistent calls with persistence: true", () => {
    const set = ruleSet({
      owner: `rules:
  - match: { action: email.send, persistence: true }
    then: deny
  - match: { action: email.send }
    then: allow
`,
    });
    const send = facts({ action: "email.send", recipients: ["bob@work.com"] });
    expect(run(set, { ...send, persistence: true }).verdict).toMatchObject({ decision: "deny" });
    expect(run(set, send).verdict).toMatchObject({ decision: "allow" });
  });
});
