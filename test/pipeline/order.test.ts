import { describe, expect, it } from "vitest";
import { callHash } from "../../src/core/call-hash.ts";
import {
  normalizationViolations,
  pauseTarget,
  UNKNOWN_PROVIDER,
} from "../../src/gateway/pipeline/pipeline.ts";
import {
  fakeNormalize,
  markReconnectRequired,
  oneRule,
  pipelineHarness,
} from "../helpers/pipeline.ts";

/**
 * The pipeline order (spec: Call model, "Pipeline order"): account and
 * pause, normalize, then pause again, the approval, rules with counts and
 * state checks, and the decision in one transaction; then execute and hide.
 */

const SEND = { action: "email.send", recipients: ["bob@vendor.com"] };

describe("pipeline order", () => {
  it("meets each stage in the spec's order on an allowed call", async () => {
    const h = pipelineHarness({ owner: oneRule("{ action: email.send }") });
    h.provider.hide = async (_call, result) => result;

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "allowed", result: { ran: "send" } });
    expect(h.stages).toEqual([
      "account",
      "pause",
      "normalize",
      "pause",
      "approval",
      "decide",
      "execute",
      "hide",
    ]);
  });

  it("reads counts while deciding, and state only for a rule whose other conditions match", async () => {
    const h = pipelineHarness({
      owner: `rules:
  - match: { action: github.merge, repo: acme/other, checks: passing }
    then: allow
  - match: { action: github.merge, items: { over: 5, per: hour } }
    then: ask
  - match: { action: github.merge, checks: passing }
    then: allow
`,
    });

    const result = await h.call({
      account: "github",
      tool: "merge",
      args: { action: "github.merge", repo: "acme/web" },
    });

    expect(result.status).toBe("allowed");
    // The first rule's repo doesn't match, so its check is never read.
    expect(h.provider.lookups).toEqual(["checks"]);
    // The lookup runs outside the transaction; the decision then starts again with fresh counts.
    expect(h.stages).toEqual([
      "account",
      "pause",
      "normalize",
      "pause",
      "approval",
      "decide",
      "counts",
      "state",
      "pause",
      "approval",
      "decide",
      "counts",
      "execute",
    ]);
  });

  it("commits the count reservation and the audit row before the call runs", async () => {
    const h = pipelineHarness({ owner: oneRule("{ action: email.send }") });
    const seen: { audit: string[]; counts: number }[] = [];
    h.provider.onExecute = () => {
      seen.push({ audit: h.audit().map((row) => row.kind), counts: h.counts().length });
    };

    await h.call({ args: SEND });

    expect(seen).toEqual([{ audit: ["allow"], counts: 1 }]);
  });

  it("writes one audit row per decision and no count event for a deny", async () => {
    const h = pipelineHarness({ owner: oneRule("{ action: email.send }", "deny") });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "denied", reason: "rule" });
    expect(h.audit().map((row) => [row.kind, row.reason])).toEqual([["deny", "rule"]]);
    expect(h.counts()).toEqual([]);
    expect(h.provider.executed).toEqual([]);
  });
});

describe("before normalizing", () => {
  it("denies an account that doesn't exist, audited under an unknown provider", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });

    const result = await h.call({ account: "gmail-nope", args: SEND });

    expect(result).toEqual({ status: "denied", reason: "account_unavailable", rule: null });
    expect(h.provider.normalized).toEqual([]);
    const [row] = h.audit();
    expect(row).toMatchObject({ kind: "deny", provider: UNKNOWN_PROVIDER, account: "gmail-nope" });
  });

  it("denies a paused call without reaching the provider definition", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });
    h.pauses.paused.agents.add(h.agent.agentId);

    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "paused", scope: "agent" });
    expect(h.stages).toEqual(["account", "pause"]);
    expect(h.provider.normalized).toEqual([]);
    expect(h.audit().map((row) => [row.kind, row.pauseScope])).toEqual([["paused", "agent"]]);
  });

  it("checks pause before the account's grant, so a paused agent learns nothing about it", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });
    markReconnectRequired(h, "gmail-work");
    h.pauses.paused.global = true;

    expect(await h.call({ args: SEND })).toEqual({ status: "paused", scope: "global" });
  });

  it("denies an account whose OAuth grant needs reconnecting", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });
    markReconnectRequired(h, "gmail-work");

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "denied", reason: "reconnect_required" });
    expect(h.provider.normalized).toEqual([]);
    // Other accounts are unaffected.
    expect((await h.call({ account: "gmail-personal", args: SEND })).status).toBe("allowed");
  });

  it("denies an account whose provider heel has no definition for", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });

    const result = await h.call({ account: "notion", tool: "create_page" });

    expect(result).toMatchObject({ status: "denied", reason: "provider_unavailable" });
  });
});

describe("normalizing", () => {
  it("denies a hard deny from the definition, even under global watch", async () => {
    const h = pipelineHarness({ owner: oneRule("{}"), watch: true });
    h.provider.normalizeHook = async () => ({ ok: false, reason: "not_available" });

    const result = await h.call({ tool: "get_message", args: { id: "m1" } });

    expect(result).toEqual({ status: "denied", reason: "not_available", rule: null });
    expect(h.provider.executed).toEqual([]);
    expect(h.counts()).toEqual([]);
  });

  it("denies a batch heel can't expand", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });

    const result = await h.call({ tool: "batch_delete", args: { ids: "m1,m2" } });

    expect(result).toMatchObject({ status: "denied", reason: "batch_unexpandable" });
  });

  it("stops at a pause that lands while the call is normalizing", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });
    h.provider.normalizeHook = async (base) => {
      h.pauses.paused.accounts.add("gmail-work");
      return fakeNormalize(base);
    };

    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "paused", scope: "account" });
    expect(h.provider.executed).toEqual([]);
    expect(h.counts()).toEqual([]);
  });

  it("hashes the arguments as they will run, after the definition's rewrites", async () => {
    const h = pipelineHarness({ owner: oneRule("{ action: github.merge }", "ask") });
    const asked = { action: "github.merge", repo: "acme/web", pr: 7 };
    const pinned = { ...asked, sha: "9f2c" };
    h.provider.normalizeHook = async (base) => fakeNormalize({ ...base, args: pinned });

    const result = await h.call({ account: "github", tool: "merge", args: asked });

    expect(result.status).toBe("pending");
    const expected = callHash({
      agentId: h.agent.agentId,
      account: "github",
      tool: "merge",
      args: pinned,
    });
    expect(h.approvals.rows[0]?.callHash).toBe(expected);
    expect(h.approvals.rows[0]?.request.call.args).toEqual(pinned);
    expect(h.audit()[0]).toMatchObject({ callHash: expected, args: pinned });
  });

  it("denies as internal when the definition changes who or where the call is", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });
    h.provider.normalizeHook = async (base) =>
      fakeNormalize({ ...base, account: "gmail-personal" });

    const result = await h.call({ args: SEND });

    expect(result).toEqual({ status: "denied", reason: "internal", rule: null });
    expect(h.provider.executed).toEqual([]);
  });

  it("finds every identity change and an unusable item count", () => {
    const h = pipelineHarness();
    const base = {
      orgId: h.t.orgId,
      agentId: h.agent.agentId,
      ownerId: h.t.ownerId,
      surface: "mcp" as const,
      account: "gmail-work",
      provider: "gmail",
      tool: "send",
      args: {},
      items: 1,
    };
    expect(normalizationViolations(base, { ...base, action: "email.send", items: 3 })).toEqual([]);
    expect(
      normalizationViolations(base, { ...base, agentId: "agt_other", runId: "r1", items: 0 }),
    ).toEqual(["agentId", "runId", "items"]);
    expect(normalizationViolations(base, { ...base, items: 1.5 })).toEqual(["items"]);
    expect(pauseTarget(base)).toEqual({
      orgId: h.t.orgId,
      agentId: h.agent.agentId,
      account: "gmail-work",
      provider: "gmail",
    });
  });
});

describe("asks and approvals (D4b's store faked in memory)", () => {
  const ASK_SENDS = oneRule("{ action: email.send }", "ask");

  it("I-51: re-sending the identical call while pending returns the same id and notifies once", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS });

    const first = await h.call({
      args: { action: "email.send", recipients: ["bob@vendor.com"], subject: "Q3" },
    });
    // Same call, keys in another order.
    const again = await h.call({
      args: { subject: "Q3", recipients: ["bob@vendor.com"], action: "email.send" },
    });

    expect(first).toMatchObject({ status: "pending" });
    expect(again).toEqual(first);
    expect(h.approvals.rows).toHaveLength(1);
    expect(h.notified).toHaveLength(1);
    expect(h.audit().map((row) => [row.kind, row.approvalId])).toEqual([
      ["ask", h.approvals.rows[0]?.id],
      ["ask", h.approvals.rows[0]?.id],
    ]);
  });

  it("I-52: a call that differs in any argument, account or tool is a separate request", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS });
    const base = { action: "email.send", recipients: ["bob@vendor.com"], subject: "Q3" };

    const ids = [
      await h.call({ args: base }),
      await h.call({ args: { ...base, subject: "Q4" } }),
      await h.call({ args: { ...base, recipients: ["bob@vendor.com", "eve@vendor.com"] } }),
      await h.call({ account: "gmail-personal", args: base }),
      await h.call({ tool: "reply", args: base }),
    ].map((result) => (result.status === "pending" ? result.approvalId : result.status));

    expect(new Set(ids).size).toBe(5);
    expect(h.notified).toEqual(ids);
  });

  it("I-52: explicit null arguments are a different call from absent ones, each audited as hashed", async () => {
    const h = pipelineHarness({ owner: oneRule("{}", "ask") });

    const absent = await h.call({ tool: "list_labels" });
    const empty = await h.call({ tool: "list_labels", args: {} });
    const nulled = await h.call({ tool: "list_labels", args: null });

    expect(empty).toEqual(absent);
    expect(nulled.status).toBe("pending");
    expect(nulled).not.toEqual(absent);
    const rows = h.audit();
    expect(rows.map((row) => row.args)).toEqual([{}, {}, null]);
    for (const row of rows) {
      expect(row.callHash).toBe(
        callHash({ agentId: row.agentId, account: row.account, tool: row.tool, args: row.args }),
      );
    }
  });

  it("joins the pending request from a new run, and keeps another agent's call separate", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS });
    const other = h.addAgent("ci-bot");

    const first = await h.call({ args: SEND, runId: "run-1" });
    const nextRun = await h.call({ args: SEND, runId: "run-2" });
    const otherAgent = await h.call({ agent: other, args: SEND, runId: "run-1" });

    expect(nextRun).toEqual(first);
    expect(otherAgent.status).toBe("pending");
    expect(otherAgent).not.toEqual(first);
  });

  it("runs an approved call once when it's re-sent, after checking the rules again", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS });
    const asked = await h.call({ args: SEND });
    if (asked.status !== "pending") throw new Error("expected pending");
    h.approvals.set(asked.approvalId, "approved");

    const rerun = await h.call({ args: SEND });
    const afterwards = await h.call({ args: SEND });

    expect(rerun).toMatchObject({
      status: "allowed",
      via: { kind: "approval", approvalId: asked.approvalId },
    });
    expect(h.provider.executed).toHaveLength(1);
    expect(h.approvals.get(asked.approvalId).status).toBe("executed");
    // Once executed, the identical call is a new call.
    expect(afterwards.status).toBe("pending");
    expect(afterwards).not.toMatchObject({ approvalId: asked.approvalId });
    expect(h.audit().map((row) => row.kind)).toEqual(["ask", "executed", "ask"]);
    expect(h.counts()).toHaveLength(1);
  });

  it("doesn't let an approval satisfy an ask from a rule that has since changed", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS });
    const asked = await h.call({ args: SEND });
    if (asked.status !== "pending") throw new Error("expected pending");
    h.approvals.set(asked.approvalId, "approved");
    h.setRules({ owner: oneRule("{ action: email.send, recipients: { max: 5 } }", "ask") });

    const rerun = await h.call({ args: SEND });

    expect(rerun.status).toBe("pending");
    expect(rerun).not.toMatchObject({ approvalId: asked.approvalId });
    expect(h.approvals.get(asked.approvalId).status).toBe("approved");
    expect(h.provider.executed).toEqual([]);
  });

  it("denies an approved call that a deny above its rule now matches, leaving the approval unused", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS });
    const asked = await h.call({ args: SEND });
    if (asked.status !== "pending") throw new Error("expected pending");
    h.approvals.set(asked.approvalId, "approved");
    h.setRules({
      owner: `rules:
  - match: { recipients: { any_domain_in: [vendor.com] } }
    then: deny
  - match: { action: email.send }
    then: ask
`,
    });

    const rerun = await h.call({ args: SEND });

    expect(rerun).toMatchObject({ status: "denied", reason: "rule" });
    expect(h.approvals.get(asked.approvalId).status).toBe("approved");
    expect(h.provider.executed).toEqual([]);
  });

  it("answers a denied request with denied and its id, and an expired one with expired", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS });
    const asked = await h.call({ args: SEND });
    if (asked.status !== "pending") throw new Error("expected pending");

    h.approvals.set(asked.approvalId, "denied");
    expect(await h.call({ args: SEND })).toEqual({
      status: "denied",
      reason: "approval_denied",
      rule: asked.rule,
      approvalId: asked.approvalId,
    });

    h.approvals.set(asked.approvalId, "expired");
    expect(await h.call({ args: SEND })).toEqual({
      status: "expired",
      approvalId: asked.approvalId,
    });
    expect(h.notified).toEqual([asked.approvalId]);
    expect(h.provider.executed).toEqual([]);
  });

  it("refuses an approved call while it's paused", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS });
    const asked = await h.call({ args: SEND });
    if (asked.status !== "pending") throw new Error("expected pending");
    h.approvals.set(asked.approvalId, "approved");
    h.pauses.paused.providers.add("gmail");

    expect(await h.call({ args: SEND })).toEqual({ status: "paused", scope: "provider" });
    expect(h.approvals.get(asked.approvalId).status).toBe("approved");
    expect(h.provider.executed).toEqual([]);
  });

  it("keeps a request pending when notifying fails, and logs it", async () => {
    const h = pipelineHarness({ owner: ASK_SENDS });
    h.notified.push = () => {
      throw new Error("SMTP refused");
    };

    const result = await h.call({ args: SEND });

    expect(result.status).toBe("pending");
    expect(h.logs()).toContain("approval notification failed");
  });
});

describe("watch mode", () => {
  it("I-71: global watch lets a would-be deny run, records it, and counts it", async () => {
    const h = pipelineHarness({ owner: oneRule("{ action: email.remove }"), watch: true });

    const result = await h.call({ args: SEND });

    expect(result).toMatchObject({ status: "allowed", via: { kind: "watch", rule: null } });
    expect(h.audit().map((row) => [row.kind, row.reason])).toEqual([
      ["would_deny", "no_rule_matched"],
    ]);
    expect(h.counts()).toHaveLength(1);
  });

  it("I-71: global watch creates no pending request and notifies no one for a would-be ask", async () => {
    const h = pipelineHarness({ owner: oneRule("{ action: email.send }", "ask"), watch: true });

    const result = await h.call({ args: SEND });

    expect(result.status).toBe("allowed");
    expect(h.approvals.rows).toEqual([]);
    expect(h.notified).toEqual([]);
    expect(h.audit().map((row) => row.kind)).toEqual(["would_ask"]);
  });

  it("I-71: global watch never relaxes an org deny", async () => {
    const h = pipelineHarness({
      org: oneRule("{ action: email.send }", "deny"),
      owner: oneRule("{}"),
      watch: true,
    });

    expect(await h.call({ args: SEND })).toMatchObject({ status: "denied", reason: "rule" });
    expect(h.provider.executed).toEqual([]);
  });

  it("I-72: a watch: true rule logs what it would decide and the next rule decides", async () => {
    const h = pipelineHarness({
      owner: `rules:
  - match: { action: email.send }
    then: deny
    watch: true
  - match: { action: email.send }
    then: allow
`,
    });

    const result = await h.call({ args: SEND });

    expect(result.status).toBe("allowed");
    expect(h.audit().map((row) => row.kind)).toEqual(["would_deny", "allow"]);
  });
});

describe("run ids", () => {
  it("stores a valid run id with the call's count event and audit row", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });

    await h.call({ args: SEND, runId: "run:2026-11-13.a_1" });

    expect(h.counts()[0]?.runId).toBe("run:2026-11-13.a_1");
    expect(h.audit()[0]?.runId).toBe("run:2026-11-13.a_1");
  });

  it("ignores and logs an invalid run id without echoing it, and the call goes on", async () => {
    const h = pipelineHarness({ owner: oneRule("{}") });

    const result = await h.call({ args: SEND, runId: "run 1; DROP TABLE" });
    await h.call({ args: SEND, runId: 42 });

    expect(result.status).toBe("allowed");
    expect(h.counts().map((row) => row.runId)).toEqual([null, null]);
    expect(h.logs()).toContain("run id ignored");
    expect(h.logs()).toContain("bad_format");
    expect(h.logs()).toContain("not_a_string");
    expect(h.logs()).not.toContain("DROP TABLE");
  });
});
