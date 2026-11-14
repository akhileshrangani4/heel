import { describe, expect, it } from "vitest";
import { createAdminHandler } from "../../src/admin/handlers.ts";
import { type AdminRequest, parseAdminRequest } from "../../src/admin/protocol.ts";
import { UsageError } from "../../src/cli/common.ts";
import { pauseParams } from "../../src/cli/main.ts";
import { LOCAL_OWNER_NAME } from "../../src/store/install.ts";
import { listPauses } from "../../src/store/pauses.ts";
import { findEnrollment } from "../../src/web/passkeys.ts";
import { type ApprovalHarness, approvalHarness, pendingId, SEND } from "../helpers/approvals.ts";
import { oneRule } from "../helpers/pipeline.ts";

const PUBLIC_URL = new URL("https://heel.example.com");

function adminFor(h: ApprovalHarness) {
  const handle = createAdminHandler({
    db: h.t.db,
    orgId: h.t.orgId,
    vault: null,
    version: "test",
    publicUrl: PUBLIC_URL,
    now: () => h.clock.now,
  });
  return async (request: AdminRequest) => handle(request);
}

describe("admin socket: passkey enrollment (Q-N2)", () => {
  it("prints a one-time link on the public URL that expires in 15 minutes", async () => {
    const h = approvalHarness();
    const admin = adminFor(h);
    const response = await admin({ method: "user.enroll", params: { name: LOCAL_OWNER_NAME } });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const { url, expiresAt } = response.result as { url: string; expiresAt: string };
    const link = new URL(url);
    expect(link.origin).toBe(PUBLIC_URL.origin);
    const token = /^\/enroll\/(.+)$/.exec(link.pathname)?.[1] ?? "";
    expect(findEnrollment(h.t.db, token, h.clock.now)).toMatchObject({ userId: h.t.ownerId });
    expect(new Date(expiresAt).getTime() - h.clock.now.getTime()).toBe(15 * 60_000);
  });

  it("refuses an unknown user", async () => {
    const h = approvalHarness();
    const response = await adminFor(h)({ method: "user.enroll", params: { name: "nobody" } });
    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
  });
});

describe("admin socket: pause", () => {
  it("I-60: pausing an agent by name stops its calls before any upstream", async () => {
    const h = approvalHarness({ owner: oneRule("{ action: email.send }") });
    const response = await adminFor(h)({
      method: "pause",
      params: { scope: "agent", name: "inbox-bot" },
    });
    expect(response).toMatchObject({
      ok: true,
      result: { scope: "agent", target: h.agent.agentId, created: true },
    });
    expect(await h.call({ args: SEND })).toEqual({ status: "paused", scope: "agent" });
    expect(h.provider.executed).toHaveLength(0);
  });

  it("I-60: pausing an account, an owner or everything stops calls in that scope", async () => {
    for (const params of [
      { scope: "account", name: "gmail-work" },
      { scope: "owner", name: LOCAL_OWNER_NAME },
      { scope: "global" },
    ] as const) {
      const h = approvalHarness({ owner: oneRule("{ action: email.send }") });
      const response = await adminFor(h)({ method: "pause", params });
      expect(response.ok).toBe(true);
      expect(await h.call({ args: SEND })).toMatchObject({ status: "paused" });
      expect(h.provider.executed).toHaveLength(0);
    }
  });

  it("is idempotent and lists what is paused", async () => {
    const h = approvalHarness();
    const admin = adminFor(h);
    await admin({ method: "pause", params: { scope: "global" } });
    expect(await admin({ method: "pause", params: { scope: "global" } })).toMatchObject({
      ok: true,
      result: { created: false },
    });
    expect(await admin({ method: "pause.list" })).toMatchObject({
      ok: true,
      result: [{ scope: "global", target: "", pausedBy: "admin-socket" }],
    });
  });

  it("refuses a target that does not exist instead of pausing nothing", async () => {
    const h = approvalHarness();
    const admin = adminFor(h);
    for (const params of [
      { scope: "agent", name: "ghost" },
      { scope: "account", name: "gmail-typo" },
      { scope: "owner", name: "nobody" },
    ] as const) {
      expect(await admin({ method: "pause", params })).toMatchObject({
        ok: false,
        error: { code: "not_found" },
      });
    }
    expect(listPauses(h.t.db, h.t.orgId)).toEqual([]);
  });

  it("Q-N5: the admin socket has no resume; resuming needs a passkey on the page", () => {
    const line = JSON.stringify({ method: "resume", params: { scope: "global" } });
    expect(parseAdminRequest(line).ok).toBe(false);
  });
});

describe("admin socket: standing approvals", () => {
  it("I-16: heel approvals revoke stops a standing approval at the next call", async () => {
    const h = approvalHarness({ owner: oneRule("{ action: email.send }", "ask") });
    const admin = adminFor(h);
    const id = pendingId(await h.call({ args: SEND }));
    const decided = h.decide(id, "approve", { standing: { scope: "rule", duration: "1d" } });
    if (!decided.ok || decided.standingApprovalId === null) throw new Error("no standing approval");
    await h.call({ args: SEND }); // uses the one-time approval

    const listed = await admin({ method: "standing.list" });
    expect(listed).toMatchObject({
      ok: true,
      result: [{ id: decided.standingApprovalId, agent: "inbox-bot", revokedAt: null }],
    });
    expect(
      await admin({ method: "standing.revoke", params: { id: decided.standingApprovalId } }),
    ).toMatchObject({ ok: true, result: { revoked: true } });
    expect(await h.call({ args: SEND })).toMatchObject({ status: "pending" });
    expect(
      await admin({ method: "standing.revoke", params: { id: decided.standingApprovalId } }),
    ).toMatchObject({ ok: false, error: { code: "conflict" } });
    expect(await admin({ method: "standing.revoke", params: { id: "std_missing" } })).toMatchObject(
      { ok: false, error: { code: "not_found" } },
    );
  });
});

describe("heel pause flags", () => {
  it("maps exactly one scope flag to admin params", () => {
    expect(pauseParams({ all: true })).toEqual({ scope: "global" });
    expect(pauseParams({ agent: "inbox-bot" })).toEqual({ scope: "agent", name: "inbox-bot" });
    expect(pauseParams({ account: "gmail-work" })).toEqual({
      scope: "account",
      name: "gmail-work",
    });
    expect(pauseParams({ owner: "alice" })).toEqual({ scope: "owner", name: "alice" });
  });

  it("refuses no scope or several scopes", () => {
    expect(() => pauseParams({})).toThrow(UsageError);
    expect(() => pauseParams({ all: true, agent: "inbox-bot" })).toThrow(UsageError);
  });
});
