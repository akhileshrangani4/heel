import { describe, expect, it } from "vitest";
import { GMAIL_MODIFY_SCOPE, googleRefresher } from "../../../src/definitions/google/oauth.ts";
import { mailboxSettings } from "../../../src/definitions/sign-in.ts";
import { findAccount } from "../../../src/store/directory.ts";
import { ConnectError, connectAccount } from "../../../src/vault/connect.ts";
import { RefreshUnavailableError } from "../../../src/vault/refresh.ts";
import { Secret } from "../../../src/vault/secret.ts";
import { FakeGoogle, TEST_GOOGLE_CLIENT } from "../../helpers/fake-google.ts";
import { humanPlaneHarness } from "../../helpers/human-plane.ts";

/**
 * Signing a Gmail account in from the Connections page (D9a-1): Google's
 * consent page, then heel's callback stores the tokens and the mailbox.
 */

function setUp() {
  const google = new FakeGoogle();
  const h = humanPlaneHarness({
    upstreamOAuth: { fetch: google.fetch },
    providerClients: { google: TEST_GOOGLE_CLIENT },
  });
  connectAccount(
    h.t.db,
    h.vault,
    { orgId: h.t.orgId, ownerId: h.t.ownerId, provider: "gmail", alias: "gmail-home" },
    new Date(),
  );
  return { h, google };
}

type Harness = ReturnType<typeof setUp>["h"];

/** The browser's part: Sign in on Connections, consent at Google, land back on heel. */
async function signIn(h: Harness, google: FakeGoogle, as: Awaited<ReturnType<Harness["signIn"]>>) {
  const started = await h.fetch("/connections/sign-in", {
    as,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: as.csrf, alias: "gmail-home" }).toString(),
  });
  expect(started.status).toBe(303);
  const callback = google.consent(started.headers.get("location") ?? "");
  const landed = await h.fetch(callback.pathname + callback.search, { as });
  expect(landed.status).toBe(303);
  const location = landed.headers.get("location") ?? "";
  const params = new URL(location, "https://x.test").searchParams;
  // A failure's words are on the page; the redirect carries only an id (red-team round 3).
  const page = params.has("failed") ? await (await h.fetch(location, { as })).text() : "";
  return {
    get: (key: string) => (key === "failed" && params.has("failed") ? page : params.get(key)),
  };
}

const account = (h: Harness) => findAccount(h.t.db, h.t.orgId, "gmail-home");

describe("Gmail sign-in", () => {
  it("stores the tokens and the mailbox, and readies the account", async () => {
    const { h, google } = setUp();
    const owner = await h.signIn(await h.enroll());
    expect(await (await h.fetch("/connections", { as: owner })).text()).toContain("Needs sign-in");

    const outcome = await signIn(h, google, owner);

    expect(outcome.get("connected")).toBe("1");
    expect(account(h)?.status).toBe("active");
    expect(mailboxSettings(account(h)?.settings ?? {})).toEqual({ mailbox: "alice@company.com" });
    const stored = h.vault.get(account(h)?.id ?? "");
    expect(stored.type === "oauth" && stored.refreshToken?.reveal()).toBe(
      "refresh-alice@company.com",
    );
  });

  it("I-74: refuses signing in again as a different mailbox", async () => {
    const { h, google } = setUp();
    const owner = await h.signIn(await h.enroll());
    await signIn(h, google, owner);
    google.mailbox = "bob@company.com";

    const outcome = await signIn(h, google, owner);

    expect(outcome.get("failed")).toContain("This account is alice@company.com");
    expect(mailboxSettings(account(h)?.settings ?? {})).toEqual({ mailbox: "alice@company.com" });
    const stored = h.vault.get(account(h)?.id ?? "");
    expect(stored.type === "oauth" && stored.refreshToken?.reveal()).toBe(
      "refresh-alice@company.com",
    );
  });

  it("refuses a sign-in that came back without a refresh token", async () => {
    const { h, google } = setUp();
    google.issueRefreshToken = false;
    const owner = await h.signIn(await h.enroll());
    const outcome = await signIn(h, google, owner);
    expect(outcome.get("failed")).toContain("no refresh token");
    expect(account(h)?.status).toBe("reconnect_required");
  });

  it("refuses a sign-in that didn't grant mail access", async () => {
    const { h, google } = setUp();
    google.grantedScope = "https://www.googleapis.com/auth/gmail.settings.basic";
    const owner = await h.signIn(await h.enroll());
    const outcome = await signIn(h, google, owner);
    expect(outcome.get("failed")).toContain("Tick every box");
    expect(account(h)?.status).toBe("reconnect_required");
  });

  it("can't be finished by someone else", async () => {
    const { h, google } = setUp();
    const owner = await h.signIn(await h.enroll());
    const started = await h.fetch("/connections/sign-in", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: owner.csrf, alias: "gmail-home" }).toString(),
    });
    const callback = google.consent(started.headers.get("location") ?? "");
    h.addUser("sam", "member");
    const other = await h.signIn(await h.enroll("sam"));

    const landed = await h.fetch(callback.pathname + callback.search, { as: other });

    // The page says why; the redirect itself carries only an id.
    const location = landed.headers.get("location") ?? "";
    expect(location).toMatch(/^\/connections\?failed=[\w-]+$/);
    expect(await (await h.fetch(location, { as: other })).text()).toContain("wasn");
    expect(account(h)?.status).toBe("reconnect_required");
  });
});

describe("connecting a Gmail account", () => {
  it("refuses a pasted credential: Gmail signs in with Google", () => {
    const { h } = setUp();
    expect(() =>
      connectAccount(
        h.t.db,
        h.vault,
        {
          orgId: h.t.orgId,
          ownerId: h.t.ownerId,
          provider: "gmail",
          alias: "gmail-other",
          credential: { type: "static", value: "pasted" },
        },
        new Date(),
      ),
    ).toThrow(ConnectError);
    expect(findAccount(h.t.db, h.t.orgId, "gmail-other")).toBeNull();
  });
});

/** One account's row on the Connections page. */
function rowOf(page: string, alias: string): string {
  const start = page.indexOf(`data-alias="${alias}"`);
  expect(start).toBeGreaterThan(-1);
  return page.slice(start, page.indexOf("</li>", start));
}

describe("Connections without providers.google", () => {
  it("names the config key and links the setup guide instead of a dead end", async () => {
    const google = new FakeGoogle();
    const h = humanPlaneHarness({ upstreamOAuth: { fetch: google.fetch } });
    for (const [provider, alias] of [
      ["gmail", "gmail-home"],
      ["google-calendar", "cal-home"],
      ["outlook", "outlook-home"],
    ] as const) {
      connectAccount(
        h.t.db,
        h.vault,
        { orgId: h.t.orgId, ownerId: h.t.ownerId, provider, alias },
        new Date(),
      );
    }
    const owner = await h.signIn(await h.enroll());

    const page = await (await h.fetch("/connections", { as: owner })).text();

    for (const alias of ["gmail-home", "cal-home"]) {
      const row = rowOf(page, alias);
      expect(row).toContain("Needs Google sign-in set up");
      expect(row).toContain("<code>providers.google</code>");
      expect(row).toContain('href="https://useheel.dev/docs/connect#google-sign-in"');
      expect(row).not.toContain("Set up with <code>heel connect</code>");
      expect(row).not.toContain('action="/connections/sign-in"');
    }
    const outlook = rowOf(page, "outlook-home");
    expect(outlook).toContain("<code>providers.microsoft</code>");
    expect(outlook).toContain('href="https://useheel.dev/docs/configuration"');
  });

  it("shows Sign in, and no setup hint, once the client is configured", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());

    const page = await (await h.fetch("/connections", { as: owner })).text();

    expect(page).not.toContain("providers.google");
    // An account that hasn't signed in yet: Sign in is the card's primary button.
    // shadcn's Button in its default (primary) variant.
    expect(rowOf(page, "gmail-home")).toMatch(/type="submit" class="btn [^"]*\bbg-primary\b/);
  });

  it("keys off the config, so a configured client gets no setup hint even while sign-in is off", async () => {
    // No upstreamOAuth: the sign-in routes are off, as when the vault is closed.
    const h = humanPlaneHarness({ providerClients: { google: TEST_GOOGLE_CLIENT } });
    connectAccount(
      h.t.db,
      h.vault,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, provider: "gmail", alias: "gmail-home" },
      new Date(),
    );
    const owner = await h.signIn(await h.enroll());

    const page = await (await h.fetch("/connections", { as: owner })).text();

    expect(rowOf(page, "gmail-home")).not.toContain("providers.google");
  });
});

describe("the Google refresher", () => {
  const request = {
    accountId: "account_1",
    provider: "gmail",
    refreshToken: new Secret("refresh-alice@company.com"),
  };

  it("returns a new access token", async () => {
    const google = new FakeGoogle();
    const refresh = googleRefresher(
      { fetch: google.fetch, now: () => new Date(0) },
      TEST_GOOGLE_CLIENT,
    );
    const tokens = await refresh(request);
    expect(tokens).toMatchObject({ expiresAt: 3_599_000, scope: GMAIL_MODIFY_SCOPE });
  });

  it("treats a revoked grant as final", async () => {
    const google = new FakeGoogle();
    google.refresh = "revoked";
    const refresh = googleRefresher(
      { fetch: google.fetch, now: () => new Date(0) },
      TEST_GOOGLE_CLIENT,
    );
    const error = await refresh(request).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(RefreshUnavailableError);
  });

  it("treats Google being down as temporary", async () => {
    const google = new FakeGoogle();
    google.refresh = "down";
    const refresh = googleRefresher(
      { fetch: google.fetch, now: () => new Date(0) },
      TEST_GOOGLE_CLIENT,
    );
    await expect(refresh(request)).rejects.toBeInstanceOf(RefreshUnavailableError);
  });
});

describe("Google Calendar sign-in", () => {
  it("asks for the calendar scopes and records the primary calendar's id", async () => {
    const google = new FakeGoogle();
    google.grantedScope =
      "https://www.googleapis.com/auth/calendar.events https://www.googleapis.com/auth/calendar.calendarlist.readonly";
    const h = humanPlaneHarness({
      upstreamOAuth: { fetch: google.fetch },
      providerClients: { google: TEST_GOOGLE_CLIENT },
    });
    connectAccount(
      h.t.db,
      h.vault,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, provider: "google-calendar", alias: "calendar" },
      new Date(),
    );
    const owner = await h.signIn(await h.enroll());
    const started = await h.fetch("/connections/sign-in", {
      as: owner,
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ csrf: owner.csrf, alias: "calendar" }).toString(),
    });
    const authorize = new URL(started.headers.get("location") ?? "");
    expect(authorize.searchParams.get("scope")).toContain("calendar.events");
    const callback = google.consent(authorize.toString());
    const landed = await h.fetch(callback.pathname + callback.search, { as: owner });
    expect(landed.headers.get("location")).toContain("connected=1");
    expect(mailboxSettings(findAccount(h.t.db, h.t.orgId, "calendar")?.settings ?? {})).toEqual({
      mailbox: "alice@company.com",
    });
  });
});
