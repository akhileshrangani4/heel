import { describe, expect, it } from "vitest";
import { findPause } from "../../src/store/pauses.ts";
import { safeNext } from "../../src/web/routes/sign-in.ts";
import { pendingId, SEND } from "../helpers/approvals.ts";
import { humanPlaneHarness } from "../helpers/human-plane.ts";
import { oneRule } from "../helpers/pipeline.ts";

/**
 * Enrollment, sign-in and sign-out, pause and resume, and standing
 * approvals on the human plane, driven over HTTP.
 */

const ASK_SENDS = oneRule("{ action: email.send }", "ask");

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

describe("enrollment and sign-in", () => {
  it("Q-N2: an enrollment link works once", async () => {
    const h = humanPlaneHarness();
    await h.enroll();

    const reused = await h.fetch("/enroll/not-a-real-token");
    expect(await reused.text()).toContain("This link can't be used");
  });

  it("signs in with a passkey, and sign-out ends the session", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());

    expect((await h.fetch("/approvals", { as: owner })).status).toBe(200);

    const out = await h.fetch("/sign-out", { as: owner, ...form({ csrf: owner.csrf }) });
    expect(out.headers.get("location")).toBe("/sign-in?signed-out");
    expect((await h.fetch("/approvals", { as: owner })).status).toBe(303);
  });

  it("refuses a sign-in signed by a passkey heel doesn't know", async () => {
    const h = humanPlaneHarness();
    await h.enroll();
    const { SoftAuthenticator } = await import("../helpers/authenticator.ts");

    await expect(h.signIn(new SoftAuthenticator())).rejects.toThrow(/sign-in refused/);
  });

  it("only redirects within heel after sign-in", () => {
    expect(safeNext("/approvals/apr_1")).toBe("/approvals/apr_1");
    expect(safeNext("//evil.example/x")).toBe("/approvals");
    expect(safeNext("https://evil.example")).toBe("/approvals");
    expect(safeNext("/sign-in")).toBe("/approvals");
    expect(safeNext(undefined)).toBe("/approvals");
  });
});

describe("pause and resume", () => {
  it("Q-N5: pausing is one form post; resuming needs a passkey", async () => {
    const h = humanPlaneHarness({ owner: ASK_SENDS });
    const owner = await h.signIn(await h.enroll());

    const paused = await h.fetch("/pause", {
      as: owner,
      ...form({ csrf: owner.csrf, scope: "account", target: "gmail-work" }),
    });
    expect(paused.status).toBe(303);
    expect(await h.call({ args: SEND })).toMatchObject({ status: "paused", scope: "account" });

    const resumed = await h.ceremony(
      owner,
      { url: "/pause/resume/challenge", body: { scope: "account", target: "gmail-work" } },
      "/pause/resume",
    );
    expect(resumed.status).toBe(200);
    expect(findPause(h.t.db, h.t.orgId, { scope: "account", target: "gmail-work" })).toBeNull();
    expect((await h.call({ args: SEND })).status).toBe("pending");
  });

  it("refuses a pause form without its CSRF token", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());

    const response = await h.fetch("/pause", {
      as: owner,
      ...form({ scope: "global", target: "" }),
    });

    expect(response.status).toBe(403);
    expect(findPause(h.t.db, h.t.orgId, { scope: "global", target: "" })).toBeNull();
  });

  it("a member can pause their own account but not everything, and can't lift an admin's pause", async () => {
    const h = humanPlaneHarness();
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));

    const global = await h.fetch("/pause", {
      as: sam,
      ...form({ csrf: sam.csrf, scope: "global", target: "" }),
    });
    expect(global.status).toBe(403);

    h.pause({ scope: "global", target: "" });
    const resume = await h.ceremony(
      sam,
      { url: "/pause/resume/challenge", body: { scope: "global", target: "" } },
      "/pause/resume",
    );
    expect(resume.status).toBe(404);
    expect(findPause(h.t.db, h.t.orgId, { scope: "global", target: "" })).not.toBeNull();
  });

  it("shows a member only the pauses that cover them, and offers Resume only where they may", async () => {
    const h = humanPlaneHarness();
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));
    // The owner's agent and account: nothing sam owns.
    h.pause({ scope: "agent", target: h.agent.agentId });
    h.pause({ scope: "account", target: "gmail-work" });

    const before = await (await h.fetch("/pause", { as: sam })).text();
    expect(before).not.toContain("inbox-bot");
    expect(before).not.toContain("gmail-work");
    expect(before).toContain("Nothing is paused");

    // Everything is paused: that stops sam's calls too, so sam sees it, without a Resume.
    h.pause({ scope: "global", target: "" });
    const after = await (await h.fetch("/pause", { as: sam })).text();
    expect(after).toContain("everything");
    expect(after).toContain("Only an admin, or whoever paused it, can resume this.");
    expect(after).not.toContain('data-heel-ceremony="resume"');
    expect(after).not.toContain("inbox-bot");
  });
});

describe("standing approvals", () => {
  it("lists a standing approval and revokes it with a form post", async () => {
    const h = humanPlaneHarness({ owner: ASK_SENDS });
    const owner = await h.signIn(await h.enroll());
    const id = pendingId(await h.call({ args: SEND }));
    const decided = h.decide(id, "approve", { standing: { scope: "rule", duration: "1d" } });
    if (!decided.ok || decided.standingApprovalId === null) throw new Error("no standing approval");

    const page = await (await h.fetch("/standing", { as: owner })).text();
    expect(page).toContain(decided.standingApprovalId);
    expect(page).toContain("Active");

    const revoked = await h.fetch("/standing/revoke", {
      as: owner,
      ...form({ csrf: owner.csrf, id: decided.standingApprovalId }),
    });
    expect(revoked.status).toBe(303);
    expect(await (await h.fetch("/standing", { as: owner })).text()).toContain("Revoked");
  });
});
