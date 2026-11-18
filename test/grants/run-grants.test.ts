import { describe, expect, it } from "vitest";
import { standingCovers } from "../../src/core/approvals.ts";
import { approvalHarness, pendingId, SEND } from "../helpers/approvals.ts";
import { oneRule } from "../helpers/pipeline.ts";

/**
 * Run-scoped grants (A4): approving "for this run" turns the rule's ask into
 * allow for this agent, only for calls carrying the same run id.
 */

const ASK_SENDS = oneRule("{ action: email.send }", "ask");
const OTHER = { ...SEND, subject: "Q4" };

describe("run-scoped standing approvals", () => {
  it("cover later calls in the same run, and nothing outside it", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND, runId: "run-1" }));
    expect(h.decide(id, "approve", { standing: { scope: "run", duration: "1d" } })).toMatchObject({
      ok: true,
    });

    // A different call under the same rule, in the same run: allowed.
    expect(await h.call({ args: OTHER, runId: "run-1" })).toMatchObject({ status: "allowed" });
    // The same call in another run, or with no run id: asks again.
    expect((await h.call({ args: OTHER, runId: "run-2" })).status).toBe("pending");
    expect((await h.call({ args: OTHER })).status).toBe("pending");
  });

  it("can't be granted on a request that came without a run id", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND }));
    expect(h.decide(id, "approve", { standing: { scope: "run", duration: "1d" } })).toMatchObject({
      ok: false,
      reason: "no_run",
    });
  });

  it("is pure: same agent, same rule, same run", () => {
    const row = {
      agentId: "a",
      scope: "run" as const,
      callHash: null,
      ruleHash: "r",
      runId: "x",
      account: "gmail",
      repo: null,
    };
    const call = (
      over: Partial<{
        agentId: string;
        ruleHash: string;
        runId: string | undefined;
        account: string;
        repo: string | undefined;
      }>,
    ) => ({
      agentId: "a",
      ruleHash: "r",
      runId: "x" as string | undefined,
      callHash: () => "h",
      account: "gmail",
      repo: undefined as string | undefined,
      ...over,
    });
    expect(standingCovers(row, call({}))).toBe(true);
    expect(standingCovers(row, call({ runId: "y" }))).toBe(false);
    expect(standingCovers(row, call({ runId: undefined }))).toBe(false);
    expect(standingCovers(row, call({ agentId: "b" }))).toBe(false);
    expect(standingCovers(row, call({ ruleHash: "s" }))).toBe(false);
    // Only the account and repo it was granted on (D13b).
    expect(standingCovers(row, call({ account: "other" }))).toBe(false);
    expect(standingCovers(row, call({ repo: "acme/web" }))).toBe(false);
    expect(standingCovers({ ...row, account: null }, call({ account: "other" }))).toBe(true);
  });

  it("lasts at most a day, however long the person picked", async () => {
    const h = approvalHarness({ owner: ASK_SENDS });
    const id = pendingId(await h.call({ args: SEND, runId: "run-1" }));
    h.decide(id, "approve", { standing: { scope: "run", duration: "30d" } });
    h.clock.advance(25 * 60 * 60_000);
    expect((await h.call({ args: OTHER, runId: "run-1" })).status).toBe("pending");
  });
});
