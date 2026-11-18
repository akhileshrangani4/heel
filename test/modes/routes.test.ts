import { describe, expect, it } from "vitest";
import { modeFor, ORG_DEFAULT, setMode, storedMode } from "../../src/store/modes.ts";
import { humanPlaneHarness } from "../helpers/human-plane.ts";

/**
 * Switching modes on the human plane (A3): admins only; tightening to
 * enforce is a plain form, loosening needs a passkey bound to the switch.
 */

function form(fields: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  };
}

describe("the Modes page", () => {
  it("an admin loosens the org default to shadow with a passkey", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    expect(await (await h.fetch("/modes", { as: admin })).text()).toContain(
      "Everyone (org default)",
    );

    const switched = await h.ceremony(
      admin,
      { url: "/modes/challenge", body: { owner: ORG_DEFAULT, mode: "shadow" } },
      "/modes/confirm",
    );

    expect(switched.status).toBe(200);
    expect(storedMode(h.t.db, h.t.orgId, ORG_DEFAULT)).toBe("shadow");
    expect(modeFor(h.t.db, h.t.orgId, h.t.ownerId, "enforce")).toBe("shadow");
  });

  it("tightening back to enforce is a plain form, and needs its CSRF token", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    setMode(h.t.db, {
      orgId: h.t.orgId,
      ownerId: ORG_DEFAULT,
      mode: "record",
      by: "x",
      at: new Date(),
    });

    const without = await h.fetch("/modes/enforce", { as: admin, ...form({ owner: ORG_DEFAULT }) });
    expect(without.status).toBe(403);
    expect(storedMode(h.t.db, h.t.orgId, ORG_DEFAULT)).toBe("record");

    const tightened = await h.fetch("/modes/enforce", {
      as: admin,
      ...form({ csrf: admin.csrf, owner: ORG_DEFAULT }),
    });
    expect(tightened.status).toBe(303);
    expect(storedMode(h.t.db, h.t.orgId, ORG_DEFAULT)).toBe("enforce");
  });

  it("refuses a challenge to switch to enforce: that's the plain form", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const response = await h.ceremony(
      admin,
      { url: "/modes/challenge", body: { owner: ORG_DEFAULT, mode: "enforce" } },
      "/modes/confirm",
    );
    expect(response.status).toBe(403);
  });

  it("a member can't see or switch modes", async () => {
    const h = humanPlaneHarness();
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));
    expect((await h.fetch("/modes", { as: sam })).status).toBe(403);
    const response = await h.ceremony(
      sam,
      { url: "/modes/challenge", body: { owner: ORG_DEFAULT, mode: "record" } },
      "/modes/confirm",
    );
    expect(response.status).toBe(403);
    expect(storedMode(h.t.db, h.t.orgId, ORG_DEFAULT)).toBeNull();
  });
});
