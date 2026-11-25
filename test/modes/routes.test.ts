import { describe, expect, it } from "vitest";
import { modeFor, ORG_DEFAULT, setMode, storedMode } from "../../src/store/modes.ts";
import { toHtmlString } from "../../src/web/ui/html.ts";
import { modesPage } from "../../src/web/ui/modes-page.ts";
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

describe("what the Modes page says", () => {
  const tighten = { action: "/modes/enforce", csrfToken: "t" };
  // The words a person reads: <main> only, tags dropped, spaces collapsed.
  const text = (html: string) =>
    (html.match(/<main[\s\S]*<\/main>/)?.[0] ?? html)
      .replace(/<script[\s\S]*?<\/script>/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ");

  it("names two modes, Enforce and Watch, and explains both", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    setMode(h.t.db, {
      orgId: h.t.orgId,
      ownerId: ORG_DEFAULT,
      mode: "record",
      by: "x",
      at: new Date(),
    });
    const page = text(await (await h.fetch("/modes", { as: admin })).text());
    expect(page).toContain("Enforce: heel applies the rules");
    expect(page).toContain("Watch: Calls your rules would deny");
    // record is stored, but shown as Watch: one name.
    expect(page).not.toMatch(/\b(shadow|record)\b/);
    expect(page).toContain("Switch Everyone (org default) to Enforce");
  });

  it("doesn't claim a switch the stored mode doesn't show", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    // Nothing is stored for this person: a crafted link can't announce a switch.
    const page = text(
      await (await h.fetch(`/modes?switched=enforce&owner=${h.t.ownerId}`, { as: admin })).text(),
    );
    expect(page).not.toContain("is now in");
  });

  it("doesn't say a person is in Watch when the org default keeps them in Enforce", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    setMode(h.t.db, {
      orgId: h.t.orgId,
      ownerId: h.t.ownerId,
      mode: "shadow",
      by: "x",
      at: new Date(),
    });
    const page = text(
      await (await h.fetch(`/modes?switched=shadow&owner=${h.t.ownerId}`, { as: admin })).text(),
    );
    expect(page).not.toContain("is now in Watch mode");
    expect(page).toContain("own mode is set to Watch, but the org default is Enforce");
    expect(page).toContain("Enforce (own setting Watch; the org default is stricter)");
    // A person's own Watch can't loosen the org's Enforce, so it isn't offered.
    expect(page).toContain("Follows the org default");
  });

  it("under --watch, the org row shows Watch and offers Enforce, not Watch again", () => {
    const page = text(
      toHtmlString(
        modesPage({
          rows: [
            {
              ownerId: ORG_DEFAULT,
              label: "Everyone (org default)",
              mode: null,
              effective: "shadow",
            },
          ],
          outcome: { kind: "none" },
          tighten,
          watchFallback: true,
        }),
      ),
    );
    expect(page).toContain("Watch (from --watch)");
    expect(page).toContain("Switch Everyone (org default) to Enforce");
    expect(page).not.toContain("Switch Everyone (org default) to Watch");
    expect(page).toContain("heel was started with --watch");
  });
});
