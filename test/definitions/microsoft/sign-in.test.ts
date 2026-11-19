import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hasScope,
  type MicrosoftClient,
  microsoftRefresher,
} from "../../../src/definitions/microsoft/oauth.ts";
import { mailboxSettings } from "../../../src/definitions/sign-in.ts";
import { findAccount } from "../../../src/store/directory.ts";
import { connectAccount } from "../../../src/vault/connect.ts";
import { RefreshUnavailableError } from "../../../src/vault/refresh.ts";
import { Secret } from "../../../src/vault/secret.ts";
import { humanPlaneHarness, PUBLIC_URL } from "../../helpers/human-plane.ts";

/**
 * Signing an Outlook account in with Microsoft (D9b), against a fake of the
 * identity platform's v2.0 endpoints and Graph's /me.
 */

const CLIENT: MicrosoftClient = {
  clientId: "heel-test-app",
  clientSecret: new Secret("test-client-secret"),
  redirectUri: new URL("/oauth/microsoft/callback", PUBLIC_URL),
  tenant: "organizations",
};

class FakeMicrosoft {
  mail: string | null = "alice@company.com";
  upn = "alice@company.onmicrosoft.com";
  scope = "Mail.ReadWrite Mail.Send MailboxSettings.ReadWrite User.Read openid profile";
  refresh: "ok" | "interaction_required" | "down" = "ok";
  readonly #codes = new Map<string, string>();

  consent(authorize: string): URL {
    const url = new URL(authorize);
    if (!url.pathname.startsWith("/organizations/oauth2/v2.0/authorize"))
      throw new Error("wrong tenant");
    if (!(url.searchParams.get("scope") ?? "").includes("offline_access"))
      throw new Error("no offline_access");
    this.#codes.set("code-1", url.searchParams.get("code_challenge") ?? "");
    const back = new URL(url.searchParams.get("redirect_uri") ?? "");
    back.searchParams.set("code", "code-1");
    back.searchParams.set("state", url.searchParams.get("state") ?? "");
    return back;
  }

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    if (url.hostname === "login.microsoftonline.com") {
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (form.get("client_secret") !== "test-client-secret") {
        return Response.json({ error: "invalid_client" }, { status: 401 });
      }
      if (form.get("grant_type") === "refresh_token") {
        if (this.refresh === "down") return new Response("busy", { status: 503 });
        if (this.refresh !== "ok") return Response.json({ error: this.refresh }, { status: 400 });
        return Response.json({
          access_token: "access-2",
          refresh_token: "refresh-2",
          expires_in: 3600,
        });
      }
      const challenge = this.#codes.get(form.get("code") ?? "");
      const verified =
        createHash("sha256")
          .update(form.get("code_verifier") ?? "")
          .digest("base64url") === challenge;
      if (!verified) return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
        scope: this.scope,
      });
    }
    if (url.hostname === "graph.microsoft.com" && url.pathname === "/v1.0/me") {
      return Response.json({ mail: this.mail, userPrincipalName: this.upn });
    }
    return Response.json({}, { status: 404 });
  };
}

function setUp() {
  const microsoft = new FakeMicrosoft();
  const h = humanPlaneHarness({
    upstreamOAuth: { fetch: microsoft.fetch },
    providerClients: { microsoft: CLIENT },
  });
  connectAccount(
    h.t.db,
    h.vault,
    { orgId: h.t.orgId, ownerId: h.t.ownerId, provider: "outlook", alias: "outlook-work" },
    new Date(),
  );
  return { h, microsoft };
}

async function signIn(h: ReturnType<typeof setUp>["h"], microsoft: FakeMicrosoft) {
  const owner = await h.signIn(await h.enroll());
  const started = await h.fetch("/connections/sign-in", {
    as: owner,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ csrf: owner.csrf, alias: "outlook-work" }).toString(),
  });
  const callback = microsoft.consent(started.headers.get("location") ?? "");
  const landed = await h.fetch(callback.pathname + callback.search, { as: owner });
  const location = landed.headers.get("location") ?? "";
  const params = new URL(location, "https://x.test").searchParams;
  // A failure's words are on the page; the redirect carries only an id (red-team round 3).
  const page = params.has("failed") ? await (await h.fetch(location, { as: owner })).text() : "";
  return {
    get: (key: string) => (key === "failed" && params.has("failed") ? page : params.get(key)),
  };
}

describe("Outlook sign-in", () => {
  it("stores the tokens and the mailbox's SMTP address", async () => {
    const { h, microsoft } = setUp();
    expect((await signIn(h, microsoft)).get("connected")).toBe("1");
    const account = findAccount(h.t.db, h.t.orgId, "outlook-work");
    expect(account?.status).toBe("active");
    expect(mailboxSettings(account?.settings ?? {})).toEqual({ mailbox: "alice@company.com" });
  });

  it("falls back to the user principal name only when there's no mail address", async () => {
    const { h, microsoft } = setUp();
    microsoft.mail = null;
    await signIn(h, microsoft);
    const account = findAccount(h.t.db, h.t.orgId, "outlook-work");
    expect(mailboxSettings(account?.settings ?? {})).toEqual({
      mailbox: "alice@company.onmicrosoft.com",
    });
  });

  it("refuses a sign-in that didn't grant sending", async () => {
    const { h, microsoft } = setUp();
    microsoft.scope = "Mail.ReadWrite User.Read";
    expect((await signIn(h, microsoft)).get("failed")).toContain("Accept every one");
    expect(findAccount(h.t.db, h.t.orgId, "outlook-work")?.status).toBe("reconnect_required");
  });
});

describe("Microsoft scopes and refresh", () => {
  it("reads scopes with or without the Graph prefix", () => {
    expect(hasScope("https://graph.microsoft.com/Mail.Send openid", "Mail.Send")).toBe(true);
    expect(hasScope("mail.send", "Mail.Send")).toBe(true);
    expect(hasScope("Mail.Read", "Mail.Send")).toBe(false);
  });

  const request = { accountId: "a", provider: "outlook", refreshToken: new Secret("refresh-1") };

  it("returns the rotated refresh token", async () => {
    const microsoft = new FakeMicrosoft();
    const tokens = await microsoftRefresher(
      { fetch: microsoft.fetch, now: () => new Date(0) },
      CLIENT,
    )(request);
    expect(tokens.refreshToken).toBe("refresh-2");
  });

  it("treats interaction_required as final and a 503 as temporary", async () => {
    const microsoft = new FakeMicrosoft();
    const refresh = microsoftRefresher({ fetch: microsoft.fetch, now: () => new Date(0) }, CLIENT);
    microsoft.refresh = "interaction_required";
    const final = await refresh(request).catch((e: unknown) => e);
    expect(final).toBeInstanceOf(Error);
    expect(final).not.toBeInstanceOf(RefreshUnavailableError);
    microsoft.refresh = "down";
    await expect(refresh(request)).rejects.toBeInstanceOf(RefreshUnavailableError);
  });
});
