import { describe, expect, it } from "vitest";
import { passkeys } from "../../src/store/schema.ts";
import { createEnrollment, pendingRecoveries } from "../../src/web/passkeys.ts";
import { humanPlaneHarness, PUBLIC_URL } from "../helpers/human-plane.ts";

/**
 * Passkeys on more devices: adding one needs a passkey you already have, and
 * a command-line link for someone who has one waits a day where they can
 * see and cancel it (an agent on the heel host can run `heel user enroll`).
 */

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

describe("adding a device", () => {
  it("gives a link that works at once, after the person confirms with their passkey", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());

    const done = await h.ceremony(
      owner,
      { url: "/devices/challenge", body: {} },
      "/devices/confirm",
    );

    expect(done.status).toBe(200);
    const { link } = (await done.json()) as { link: string };
    const page = await (await h.fetch(new URL(link).pathname)).text();
    expect(page).toContain("Create a passkey");
    expect(pendingRecoveries(h.t.db, h.t.orgId, h.clock.now)).toEqual([]);
  });

  it("refuses without the CSRF token", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const response = await h.fetch("/devices/challenge", {
      as: owner,
      csrf: false,
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(403);
  });
});

describe("recovery links", () => {
  it("shows a waiting recovery link on the approval page, and the person can cancel it", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const recovery = createEnrollment(h.t.db, {
      orgId: h.t.orgId,
      userName: "owner",
      publicUrl: PUBLIC_URL,
      now: h.clock.now,
    });
    expect(recovery.activeFrom).not.toBeNull();

    const waiting = await (await h.fetch(new URL(recovery.url).pathname)).text();
    expect(waiting).toContain("This recovery link works from");
    expect(waiting).not.toContain("Create a passkey");

    const list = await (await h.fetch("/approvals", { as: owner })).text();
    expect(list).toContain("A recovery link for owner was made");
    const [pending] = pendingRecoveries(h.t.db, h.t.orgId, h.clock.now);

    const cancelled = await h.fetch("/enroll/recoveries/cancel", {
      as: owner,
      ...form({ csrf: owner.csrf, id: pending?.id ?? "" }),
    });
    expect(cancelled.status).toBe(303);
    expect(pendingRecoveries(h.t.db, h.t.orgId, h.clock.now)).toEqual([]);
    expect(await (await h.fetch("/approvals", { as: owner })).text()).not.toContain(
      "A recovery link",
    );
    expect(h.t.db.select().from(passkeys).all()).toHaveLength(1);
  });
});
