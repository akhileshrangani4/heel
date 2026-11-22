import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { accounts, users } from "../../src/store/schema.ts";
import { setApprovers, sharingOf } from "../../src/store/sharing.ts";
import { groupLines } from "../../src/web/routes/manage-accounts.ts";
import { connectionsPage } from "../../src/web/ui/connections.ts";
import {
  type Browser,
  type HumanPlaneHarness,
  humanPlaneHarness,
  PUBLIC_URL,
} from "../helpers/human-plane.ts";

/**
 * Roadmap 2.9, part 4: sharing an account and naming its approvers from the
 * web app, as `heel account share` and `heel account approvers` do. Both ask
 * for a passkey and act on the account and person that were signed; stopping
 * a share is a plain form.
 */

function manage(h: HumanPlaneHarness, as: Browser, body: Record<string, string>) {
  return h.ceremony(
    as,
    { url: "/connections/manage/challenge", body },
    "/connections/manage/confirm",
    {},
  );
}

async function setUp() {
  const h = humanPlaneHarness({
    upstreamOAuth: { fetch: async () => new Response("unexpected", { status: 500 }) },
    checkKey: async () => ({ status: "ok" }),
  });
  const owner = await h.signIn(await h.enroll());
  h.addUser("sam", "member");
  const sam = await h.signIn(await h.enroll("sam"));
  await h.ceremony(
    owner,
    {
      url: "/connections/manage/challenge",
      body: { op: "connect", service: "github", alias: "gh-web" },
    },
    "/connections/manage/confirm",
    { key: "ghp_x" },
  );
  return { h, owner, sam };
}

describe("sharing accounts in the web app (2.9)", () => {
  it("shares an account with someone after a passkey, and stops sharing with a plain form", async () => {
    const { h, owner } = await setUp();
    const page = await (await h.fetch("/connections", { as: owner })).text();
    expect(page).toContain("Who can use it");
    expect(page).toContain('<option value="sam">sam</option>');

    const done = await manage(h, owner, {
      op: "share",
      alias: "gh-web",
      kind: "user",
      person: "sam",
    });
    expect(done.status).toBe(200);
    expect(sharingOf(h.t.db, h.t.orgId, "gh-web").sharedWith).toEqual([{ user: "sam" }]);
    const { next } = (await done.json()) as { next: string };
    expect(await (await h.fetch(next, { as: owner })).text()).toContain(
      "Changed who can use <strong>gh-web</strong>",
    );

    const stopped = await h.fetch("/connections/gh-web/unshare", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: owner.csrf, kind: "user", name: "sam" }).toString(),
    });
    expect(stopped.status).toBe(303);
    expect(sharingOf(h.t.db, h.t.orgId, "gh-web").sharedWith).toEqual([]);
  });

  it("only the owner shares an account, only with someone else on this heel", async () => {
    const { h, owner, sam } = await setUp();
    expect(
      (await manage(h, sam, { op: "share", alias: "gh-web", kind: "user", person: "sam" })).status,
    ).toBe(400);
    expect(
      (await manage(h, owner, { op: "share", alias: "gh-web", kind: "user", person: "owner" }))
        .status,
    ).toBe(400);
    expect(
      (await manage(h, owner, { op: "share", alias: "gh-web", kind: "user", person: "nobody" }))
        .status,
    ).toBe(400);
    // Groups come from a sign-in provider; this heel has none.
    expect(
      (await manage(h, owner, { op: "share", alias: "gh-web", kind: "group", group: "eng" }))
        .status,
    ).toBe(400);
    const unshare = await h.fetch("/connections/gh-web/unshare", {
      as: sam,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: sam.csrf, kind: "user", name: "sam" }).toString(),
    });
    expect(unshare.status).toBe(404);
  });

  it("won't share with someone disabled between the passkey prompt and the tap", async () => {
    const { h, owner } = await setUp();
    const challenge = await h.fetch("/connections/manage/challenge", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({ op: "share", alias: "gh-web", kind: "user", person: "sam" }),
    });
    expect(challenge.status).toBe(200);
    const { challengeId, options } = (await challenge.json()) as {
      challengeId: string;
      options: Parameters<Browser["authenticator"]["assert"]>[0];
    };
    h.t.db.update(users).set({ disabledAt: h.clock.now }).where(eq(users.name, "sam")).run();
    const done = await h.fetch("/connections/manage/confirm", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": owner.csrf },
      body: JSON.stringify({
        challengeId,
        response: owner.authenticator.assert(options, PUBLIC_URL.origin),
      }),
    });
    expect(done.status).toBe(409);
    expect(sharingOf(h.t.db, h.t.orgId, "gh-web").sharedWith).toEqual([]);
  });

  it("names approvers, for every call or one GitHub repo, and clears them", async () => {
    const { h, owner } = await setUp();
    const set = await manage(h, owner, { op: "approvers", alias: "gh-web", "user:sam": "on" });
    expect(set.status).toBe(200);
    expect(sharingOf(h.t.db, h.t.orgId, "gh-web").approvers).toEqual([{ user: "sam" }]);

    expect(
      (await manage(h, owner, { op: "approvers", alias: "gh-web", repo: "not a repo" })).status,
    ).toBe(400);
    const repo = await manage(h, owner, {
      op: "approvers",
      alias: "gh-web",
      repo: "Acme/Site",
      "user:sam": "on",
    });
    expect(repo.status).toBe(200);
    expect(sharingOf(h.t.db, h.t.orgId, "gh-web").approvers).toContainEqual({
      user: "sam",
      repo: "acme/site",
    });

    // Nobody ticked: the owner decides again.
    expect((await manage(h, owner, { op: "approvers", alias: "gh-web" })).status).toBe(200);
    expect(sharingOf(h.t.db, h.t.orgId, "gh-web").approvers).toEqual([
      { user: "sam", repo: "acme/site" },
    ]);
    expect(
      (await manage(h, owner, { op: "approvers", alias: "gh-web", "user:nobody": "on" })).status,
    ).toBe(400);
  });

  it("only an admin names approvers: a member can't clear the one an admin put on their account", async () => {
    const { h, owner, sam } = await setUp();
    await manage(h, sam, { op: "connect", service: "github", alias: "sam-gh" });
    await h.ceremony(
      sam,
      {
        url: "/connections/manage/challenge",
        body: { op: "connect", service: "github", alias: "sam-gh2" },
      },
      "/connections/manage/confirm",
      { key: "ghp_y" },
    );
    setApprovers(
      h.t.db,
      h.t.orgId,
      "sam-gh2",
      null,
      [{ kind: "user", name: "owner" }],
      h.clock.now,
    );
    expect((await manage(h, sam, { op: "approvers", alias: "sam-gh2" })).status).toBe(400);
    expect(sharingOf(h.t.db, h.t.orgId, "sam-gh2").approvers).toEqual([{ user: "owner" }]);
    const page = await (await h.fetch("/connections", { as: sam })).text();
    expect(page).toContain("An admin sets who approves");
    expect(page).not.toContain("approvers-row0-all");
    // The owner here is an admin.
    expect(
      (await manage(h, owner, { op: "approvers", alias: "gh-web", "user:sam": "on" })).status,
    ).toBe(200);
  });

  it("gives each scope its own form, starting from that scope's approvers", async () => {
    const { h, owner } = await setUp();
    await manage(h, owner, { op: "approvers", alias: "gh-web", "user:sam": "on" });
    // The new-repo form, left empty, doesn't replace the approvers for every call.
    expect(
      (await manage(h, owner, { op: "approvers", alias: "gh-web", scope: "repo", repo: "" }))
        .status,
    ).toBe(400);
    expect(sharingOf(h.t.db, h.t.orgId, "gh-web").approvers).toEqual([{ user: "sam" }]);
    await manage(h, owner, {
      op: "approvers",
      alias: "gh-web",
      scope: "repo",
      repo: "acme/prod",
      "user:sam": "on",
    });
    const page = await (await h.fetch("/connections", { as: owner })).text();
    expect(page).toMatch(/id="approvers-row0-all-0" type="checkbox" name="user:sam" checked/);
    expect(page).toContain("For acme/prod only");
  });

  it("keeps a group whose name holds a comma when the form is saved as it was filled", () => {
    const page = String(
      connectionsPage({
        rows: [
          {
            alias: "gh",
            provider: "github",
            status: "active",
            signsIn: false,
            setup: null,
            sharing: { sharedWith: [], approvers: [{ group: "Eng, Platform" }, { group: "sec" }] },
          },
        ],
        outcome: { kind: "none" },
        signInForm: { action: "/connections/sign-in", csrfToken: "t" },
        manage: { csrfToken: "t", people: ["sam"], groups: true, admin: true },
      }),
    );
    const filled = /name="groups"[^>]*>\n([^<]*)<\/textarea>/.exec(page)?.[1] ?? "";
    expect(groupLines(filled)).toEqual(["Eng, Platform", "sec"]);
  });

  it("refuses repo approvers on an account that isn't GitHub", async () => {
    const { h, owner } = await setUp();
    await manage(h, owner, { op: "connect", service: "gmail", alias: "mail-web" });
    expect(
      h.t.db
        .select()
        .from(accounts)
        .all()
        .some((a) => a.alias === "mail-web"),
    ).toBe(true);
    expect(
      (await manage(h, owner, { op: "approvers", alias: "mail-web", repo: "acme/site" })).status,
    ).toBe(400);
  });
});
