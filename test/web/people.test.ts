import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createAdminHandler } from "../../src/admin/handlers.ts";
import { enrollments, passkeys, users } from "../../src/store/schema.ts";
import {
  type Browser,
  type HumanPlaneHarness,
  humanPlaneHarness,
  PUBLIC_URL,
} from "../helpers/human-plane.ts";

/**
 * Roadmap 2.9, part 4: people in the web app. Admins add a person by name
 * (without a sign-in provider) and make passkey links; anyone sets their own
 * notification email. Every change asks for a passkey; a link is shown once.
 */

function people(h: HumanPlaneHarness, as: Browser, body: Record<string, string>) {
  return h.ceremony(as, { url: "/people/challenge", body }, "/people/confirm", {});
}

async function setUp() {
  const h = humanPlaneHarness();
  const owner = await h.signIn(await h.enroll());
  return { h, owner };
}

describe("people in the web app (2.9)", () => {
  it("an admin adds a person by name and gets their passkey link, once", async () => {
    const { h, owner } = await setUp();
    const page = await (await h.fetch("/people", { as: owner })).text();
    expect(page).toContain("Add a person");

    const done = await people(h, owner, { op: "add", name: "sam" });
    expect(done.status).toBe(200);
    const { next } = (await done.json()) as { next: string };
    expect(next).toMatch(/^\/people\/link\/[\w-]+$/);
    const sam = h.t.db.select().from(users).where(eq(users.name, "sam")).get();
    expect(sam?.role).toBe("member");

    const shown = await h.fetch(next, { as: owner });
    expect(shown.headers.get("cache-control")).toBe("no-store");
    const text = await shown.text();
    expect(text).toContain(`${PUBLIC_URL.origin}/enroll/`);
    expect(text).toContain("sam's passkey link");
    // Once.
    expect(await (await h.fetch(next, { as: owner })).text()).toContain("already shown");
    // The link works: sam enrolls with it.
    const link = /value="(https:\/\/heel\.example\.com\/enroll\/[^"]+)"/.exec(text)?.[1];
    expect(link).toBeDefined();
    expect(
      h.t.db
        .select()
        .from(enrollments)
        .all()
        .filter((e) => e.userId === sam?.id),
    ).toHaveLength(1);
    expect((await h.fetch(new URL(link ?? "").pathname)).status).toBe(200);
  });

  it("refuses a bad or taken name, and adding from a non-admin", async () => {
    const { h, owner } = await setUp();
    expect((await people(h, owner, { op: "add", name: "Sam!" })).status).toBe(400);
    expect((await people(h, owner, { op: "add", name: "OWNER" })).status).toBe(400);
    h.addUser("pat", "member");
    const pat = await h.signIn(await h.enroll("pat"));
    expect((await people(h, pat, { op: "add", name: "eve" })).status).toBe(400);
    expect((await people(h, pat, { op: "link", name: "owner" })).status).toBe(400);
    const page = await (await h.fetch("/people", { as: pat })).text();
    expect(page).not.toContain("Add a person");
    expect(page).not.toContain(">owner<");
  });

  it("a link for someone with a passkey is a recovery link that waits a day", async () => {
    const { h, owner } = await setUp();
    h.addUser("pat", "member");
    await h.enroll("pat");
    const done = await people(h, owner, { op: "link", name: "pat" });
    expect(done.status).toBe(200);
    const { next } = (await done.json()) as { next: string };
    expect(await (await h.fetch(next, { as: owner })).text()).toContain("A recovery link");
    // Never for yourself: your own devices are added from Approvals, at once.
    expect((await people(h, owner, { op: "link", name: "owner" })).status).toBe(400);
  });

  it("a passkey for heel's old address still makes it a recovery link, as the page says", async () => {
    const { h, owner } = await setUp();
    h.addUser("pat", "member");
    await h.enroll("pat");
    const pat = h.t.db.select().from(users).where(eq(users.name, "pat")).get();
    h.t.db
      .update(passkeys)
      .set({ rpId: "old.example.com" })
      .where(eq(passkeys.userId, pat?.id ?? ""))
      .run();
    expect(await (await h.fetch("/people", { as: owner })).text()).toContain(
      "Make a recovery link",
    );
    const done = await people(h, owner, { op: "link", name: "pat" });
    const { next } = (await done.json()) as { next: string };
    expect(await (await h.fetch(next, { as: owner })).text()).toContain("A recovery link");
    const row = h.t.db
      .select()
      .from(enrollments)
      .all()
      .find((e) => e.userId === pat?.id);
    expect(row?.notBefore).not.toBeNull();
  });

  it("a member can't find out who else is here from the email form", async () => {
    const { h } = await setUp();
    h.addUser("pat", "member");
    const pat = await h.signIn(await h.enroll("pat"));
    const real = await people(h, pat, { op: "email", name: "owner", email: "a@example.com" });
    const made_up = await people(h, pat, { op: "email", name: "nobody", email: "a@example.com" });
    expect(await real.text()).toBe(await made_up.text());
  });

  it("only the admin who made a link sees it", async () => {
    const { h, owner } = await setUp();
    h.addUser("pat", "member");
    const pat = await h.signIn(await h.enroll("pat"));
    const done = await people(h, owner, { op: "add", name: "sam" });
    const { next } = (await done.json()) as { next: string };
    expect(await (await h.fetch(next, { as: pat })).text()).toContain("already shown");
  });

  it("anyone sets their own notification email; only admins set someone else's", async () => {
    const { h, owner } = await setUp();
    h.addUser("pat", "member");
    const pat = await h.signIn(await h.enroll("pat"));
    expect(
      (await people(h, pat, { op: "email", name: "pat", email: "pat@example.com" })).status,
    ).toBe(200);
    expect(h.t.db.select().from(users).where(eq(users.name, "pat")).get()?.email).toBe(
      "pat@example.com",
    );
    expect(
      (await people(h, pat, { op: "email", name: "owner", email: "evil@example.com" })).status,
    ).toBe(400);
    expect((await people(h, pat, { op: "email", name: "pat", email: "not an email" })).status).toBe(
      400,
    );
    expect((await people(h, owner, { op: "email", name: "pat", email: "" })).status).toBe(200);
    expect(h.t.db.select().from(users).where(eq(users.name, "pat")).get()?.email).toBeNull();
  });

  it("heel user add adds a member, but not where people sign in with a provider", () => {
    const { h } = { h: humanPlaneHarness() };
    const base = {
      db: h.t.db,
      orgId: h.t.orgId,
      vault: null,
      version: "test",
      publicUrl: PUBLIC_URL,
    };
    expect(createAdminHandler(base)({ method: "user.add", params: { name: "sam" } })).toMatchObject(
      {
        ok: true,
      },
    );
    expect(createAdminHandler(base)({ method: "user.add", params: { name: "Sam" } })).toMatchObject(
      {
        ok: false,
      },
    );
    expect(
      createAdminHandler({ ...base, teamSignIn: true })({
        method: "user.add",
        params: { name: "kim" },
      }),
    ).toMatchObject({ ok: false });
  });
});
