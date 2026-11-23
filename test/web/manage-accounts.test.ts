import { describe, expect, it } from "vitest";
import { accounts, credentials } from "../../src/store/schema.ts";
import { type Browser, type HumanPlaneHarness, humanPlaneHarness } from "../helpers/human-plane.ts";

/**
 * Roadmap 2.9, part 2: accounts from the web app. Connecting one and
 * replacing its key ask for a passkey; the key travels only with the signed
 * answer and goes to the vault. Removing one is a plain form.
 */

function manage(h: HumanPlaneHarness, as: Browser, body: Record<string, string>, key?: string) {
  return h.ceremony(
    as,
    { url: "/connections/manage/challenge", body },
    "/connections/manage/confirm",
    key === undefined ? {} : { key },
  );
}

const form = (as: Browser): RequestInit & { as: Browser } => ({
  as,
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ csrf: as.csrf }).toString(),
});

function setUp() {
  const checked: string[] = [];
  const h = humanPlaneHarness({
    // The vault comes with upstream sign-in, as in a real heel with a master key.
    upstreamOAuth: { fetch: async () => new Response("unexpected", { status: 500 }) },
    checkKey: async (_provider, key) => {
      checked.push(key);
      return key === "bad"
        ? { status: "rejected", message: "GitHub turned that key down." }
        : { status: "ok" };
    },
  });
  return { h, checked };
}

describe("accounts in the web app (2.9)", () => {
  it("connects a key account with a passkey, checking the key and storing it only in the vault", async () => {
    const { h, checked } = setUp();
    const owner = await h.signIn(await h.enroll());
    const rejected = await manage(
      h,
      owner,
      { op: "connect", service: "github", alias: "gh-web" },
      "bad",
    );
    expect(rejected.status).toBe(409);
    expect(
      h.t.db
        .select()
        .from(accounts)
        .all()
        .some((a) => a.alias === "gh-web"),
    ).toBe(false);
    const missing = await manage(h, owner, { op: "connect", service: "github", alias: "gh-web" });
    expect(missing.status).toBe(400);

    const done = await manage(
      h,
      owner,
      { op: "connect", service: "github", alias: "gh-web" },
      "ghp_secret_value",
    );
    expect(done.status).toBe(200);
    const { next } = (await done.json()) as { next: string };
    expect(next).toMatch(/^\/connections\?note=/);
    expect(checked).toEqual(["bad", "ghp_secret_value"]);
    const row = h.t.db
      .select()
      .from(accounts)
      .all()
      .find((a) => a.alias === "gh-web");
    expect(row).toMatchObject({ provider: "github", ownerId: h.t.ownerId });
    // Stored sealed: the raw key isn't in the credentials table, or on the page.
    const sealed = JSON.stringify(h.t.db.select().from(credentials).all());
    expect(sealed).not.toContain("ghp_secret_value");
    const page = await (await h.fetch(next, { as: owner })).text();
    expect(page).toContain("Connected <strong>gh-web</strong>");
    expect(page).not.toContain("ghp_secret_value");
    // A note is read once: the same link says nothing the second time.
    expect(await (await h.fetch(next, { as: owner })).text()).not.toContain("Connected <strong>");
  });

  it("connects a sign-in account with no key, and refuses a taken name before the passkey", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    const done = await manage(h, owner, { op: "connect", service: "gmail", alias: "mail-web" });
    expect(done.status).toBe(200);
    expect(
      h.t.db
        .select()
        .from(accounts)
        .all()
        .find((a) => a.alias === "mail-web")?.provider,
    ).toBe("gmail");
    expect(
      (await manage(h, owner, { op: "connect", service: "gmail", alias: "mail-web" })).status,
    ).toBe(400);
    expect((await manage(h, owner, { op: "connect", service: "nope", alias: "x" })).status).toBe(
      400,
    );
  });

  it("takes a name typed on a phone: a capital first letter and spaces", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    const done = await manage(h, owner, { op: "connect", service: "gmail", alias: " Mail Work " });
    expect(done.status).toBe(200);
    const aliases = h.t.db
      .select()
      .from(accounts)
      .all()
      .map((a) => a.alias);
    expect(aliases).toContain("mail-work");
    const page = await (await h.fetch("/connections", { as: owner })).text();
    expect(page).toMatch(/id="connect-alias"[^>]*autocapitalize="off"/);
  });

  it("replaces a key with a passkey and removes an account with a form, only the owner's", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    await manage(h, owner, { op: "connect", service: "github", alias: "gh-web" }, "first");
    const before = JSON.stringify(h.t.db.select().from(credentials).all());
    expect((await manage(h, owner, { op: "rekey", alias: "gh-web" }, "second")).status).toBe(200);
    expect(JSON.stringify(h.t.db.select().from(credentials).all())).not.toBe(before);

    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));
    expect((await manage(h, sam, { op: "rekey", alias: "gh-web" }, "evil")).status).toBe(400);
    expect((await h.fetch("/connections/gh-web/remove", form(sam))).status).toBe(404);

    const removed = await h.fetch("/connections/gh-web/remove", form(owner));
    expect(removed.status).toBe(303);
    expect(
      h.t.db
        .select()
        .from(accounts)
        .all()
        .some((a) => a.alias === "gh-web"),
    ).toBe(false);
    const page = await (await h.fetch(removed.headers.get("location") ?? "", { as: owner })).text();
    expect(page).toContain("Removed <strong>gh-web</strong>");
  });

  it("claims nothing from a crafted link, and refuses before the passkey when the vault is closed", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    await manage(h, owner, { op: "connect", service: "github", alias: "gh-web" }, "first");
    for (const query of [
      "rekeyed=gh-web",
      "connected-here=gh-web",
      "removed=anything",
      "note=made-up",
    ]) {
      const page = await (await h.fetch(`/connections?${query}`, { as: owner })).text();
      expect(page).not.toMatch(/Replaced <strong>|Connected <strong>|Removed <strong>/);
    }
    const closed = humanPlaneHarness();
    const someone = await closed.signIn(await closed.enroll());
    const refused = await manage(closed, someone, {
      op: "connect",
      service: "github",
      alias: "gh",
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toMatch(/vault isn't open/);
  });
});
