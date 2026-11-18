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
  return new URL(landed.headers.get("location") ?? "", "https://x.test").searchParams;
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

    expect(landed.headers.get("location")).toContain("wasn");
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
