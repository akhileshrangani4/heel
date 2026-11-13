import { describe, expect, it } from "vitest";
import type { StateCheck } from "../../src/core/rules/compile.ts";
import { type LookupBehavior, pipelineHarness } from "../helpers/pipeline.ts";

/**
 * Fail-closed row "A state lookup errors or times out after 5 s" (spec:
 * Fail-closed behavior; Counts and state checks): the whole call is denied
 * with `state_check_unavailable`. The condition is never treated as false,
 * so the broad allow below the rule must not decide the call.
 */

const MERGE = {
  account: "github",
  tool: "merge",
  args: { action: "github.merge", repo: "acme/web" },
};
const SEND = { args: { action: "email.send", recipients: ["bob@vendor.com"] } };

const RULES: Record<StateCheck, string> = {
  checks: `rules:
  - match: { action: github.merge, checks: passing }
    then: allow
  - match: {}
    then: allow
`,
  all_in_thread: `rules:
  - match: { action: email.send, recipients: { all_in_thread: true } }
    then: allow
  - match: {}
    then: allow
`,
};

const CALLS: Record<StateCheck, typeof MERGE | typeof SEND> = {
  checks: MERGE,
  all_in_thread: SEND,
};

const FAILURES: LookupBehavior[] = ["throw", "hang", "garbage"];
const CHECKS: StateCheck[] = ["checks", "all_in_thread"];

describe("fail closed: state lookups", () => {
  describe.each(CHECKS)("%s", (check) => {
    it("runs the call when the lookup passes, so the rules themselves allow it", async () => {
      const h = pipelineHarness({ owner: RULES[check] });

      const result = await h.call(CALLS[check]);

      expect(result.status).toBe("allowed");
      expect(h.provider.lookups).toEqual([check]);
    });

    it.each(FAILURES)("denies the whole call when the lookup does '%s'", async (behavior) => {
      const h = pipelineHarness({ owner: RULES[check], timeouts: { stateCheckMs: 50 } });
      h.provider.states.set(check, behavior);

      const started = performance.now();
      const result = await h.call(CALLS[check]);

      expect(result).toMatchObject({ status: "denied", reason: "state_check_unavailable" });
      // The broad allow below never got to decide, and nothing went upstream.
      expect(h.provider.executed).toEqual([]);
      expect(h.counts()).toEqual([]);
      expect(h.audit()).toEqual([
        expect.objectContaining({ kind: "deny", reason: "state_check_unavailable" }),
      ]);
      // A hang ends at the lookup deadline, not at the test's.
      expect(performance.now() - started).toBeLessThan(5_000);
    });

    it("denies when the definition has no lookup for the check", async () => {
      const h = pipelineHarness({ owner: RULES[check] });
      h.provider.hasStateChecks = false;

      const result = await h.call(CALLS[check]);

      expect(result).toMatchObject({ status: "denied", reason: "state_check_unavailable" });
      expect(h.provider.executed).toEqual([]);
    });
  });

  it("never reads state for a rule whose other conditions don't match", async () => {
    const h = pipelineHarness({ owner: RULES.checks });
    h.provider.states.set("checks", "throw");

    // A send doesn't match the merge rule, so the failing merge lookup is never consulted.
    const result = await h.call(SEND);

    expect(result.status).toBe("allowed");
    expect(h.provider.lookups).toEqual([]);
  });
});
