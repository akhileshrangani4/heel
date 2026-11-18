import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { oidcSignIns, sessions, users } from "../../src/store/schema.ts";
import { OidcClient } from "../../src/teams/oidc.ts";
import { MAX_PENDING } from "../../src/teams/sign-in.ts";
import { safeNext } from "../../src/web/routes/sign-in.ts";
import { humanPlaneHarness, PUBLIC_URL } from "../helpers/human-plane.ts";
import { MockIssuer } from "../helpers/oidc-issuer.ts";

/** Team sign-in through the IdP (D13b), from the sign-in page to a session. */

describe("OIDC sign-in", () => {
  let issuer: MockIssuer;

  beforeEach(async () => {
    issuer = await MockIssuer.start();
    issuer.idTokenClaims = {
      groups: ["engineering"],
      preferred_username: "Dana",
      email: "dana@example.com",
      email_verified: true,
    };
  });
  afterEach(async () => {
    await issuer.close();
  });

  function setUp() {
    let client: Promise<OidcClient> | null = null;
    const h = humanPlaneHarness({
      oidc: {
        name: "Example SSO",
        client: () => {
          client ??= OidcClient.discover(
            {
              issuer: issuer.url,
              clientId: "heel-test",
              redirectUri: new URL("/auth/oidc/callback", PUBLIC_URL),
              scopes: ["openid", "profile", "email"],
              groupsClaim: "groups",
              roles: { admin: ["heel-admins"], member: ["engineering"] },
              clientSecret: null,
            },
            { now: () => h.clock.now },
          );
          return client;
        },
      },
    });
    return h;
  }

  /** Starts a sign-in; returns the binding cookie and the URL the IdP sends the person back to. */
  async function start(h: ReturnType<typeof setUp>, next = "/approvals") {
    const response = await h.fetch(`/auth/oidc?next=${encodeURIComponent(next)}`);
    expect(response.status).toBe(303);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie.startsWith("__Host-heel_oidc=")).toBe(true);
    const callback = issuer.authorize(new URL(response.headers.get("location") ?? ""));
    return { cookie, callback };
  }

  const back = (h: ReturnType<typeof setUp>, callback: URL, cookie?: string) =>
    h.fetch(
      `${callback.pathname}${callback.search}`,
      cookie === undefined ? {} : { headers: { cookie } },
    );

  /** Where a successful callback's page sends the browser, or null when it signed nobody in. */
  const signedInTo = async (response: Response) => {
    if (!(response.headers.get("set-cookie") ?? "").includes("heel_session=")) return null;
    return /url=([^"]+)"/.exec(await response.text())?.[1] ?? null;
  };

  const dana = (h: ReturnType<typeof setUp>) =>
    h.t.db.select().from(users).where(eq(users.name, "dana")).get();

  it("shows the organization's sign-in on a team install", async () => {
    const h = setUp();
    expect(await (await h.fetch("/sign-in")).text()).toContain("Sign in with Example SSO");
  });

  it("signs a person in, with the role and groups the IdP gives and a normalized name", async () => {
    const h = setUp();
    const { cookie, callback } = await start(h, "/activity");
    const response = await back(h, callback, cookie);
    // A page, not a redirect: the Strict session cookie isn't sent on the IdP's redirect chain.
    expect(response.status).toBe(200);
    expect(response.headers.get("set-cookie")).toContain("__Host-heel_session=");
    expect(await signedInTo(response)).toBe("/activity");
    expect(dana(h)).toMatchObject({
      role: "member",
      groups: ["engineering"],
      email: "dana@example.com",
    });
    expect(dana(h)?.oidcSubject).toBe(`${issuer.url.href.replace(/\/$/, "")} user-123`);
  });

  it("reads the role again at every sign-in", async () => {
    const h = setUp();
    let s = await start(h);
    await back(h, s.callback, s.cookie);
    issuer.idTokenClaims = { ...issuer.idTokenClaims, groups: ["heel-admins"] };
    s = await start(h);
    await back(h, s.callback, s.cookie);
    expect(dana(h)?.role).toBe("admin");
  });

  it("refuses someone in no mapped group", async () => {
    const h = setUp();
    issuer.idTokenClaims = { ...issuer.idTokenClaims, groups: ["sales"] };
    const { cookie, callback } = await start(h);
    const response = await back(h, callback, cookie);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("isn&#39;t in a group");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("heel_session=");
  });

  it("demotes someone moved out of every group and ends their sessions", async () => {
    const h = setUp();
    issuer.idTokenClaims = { ...issuer.idTokenClaims, groups: ["heel-admins"] };
    let s = await start(h);
    await back(h, s.callback, s.cookie);
    issuer.idTokenClaims = { ...issuer.idTokenClaims, groups: [] };
    s = await start(h);
    expect((await back(h, s.callback, s.cookie)).status).toBe(403);
    expect(dana(h)).toMatchObject({ role: "member", groups: [] });
    const rows = h.t.db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, dana(h)?.id ?? ""))
      .all();
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.endedAt !== null)).toBe(true);
  });

  it("completes only in the browser that started it, and only once", async () => {
    const h = setUp();
    const { cookie, callback } = await start(h);
    expect(await signedInTo(await back(h, callback))).toBeNull();
    expect(await signedInTo(await back(h, callback, "__Host-heel_oidc=forged"))).toBeNull();
    expect(await signedInTo(await back(h, callback, cookie))).toBe("/approvals");
    expect(await signedInTo(await back(h, callback, cookie))).toBeNull();
  });

  it("refuses a disabled user", async () => {
    const h = setUp();
    let s = await start(h);
    await back(h, s.callback, s.cookie);
    h.t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.name, "dana")).run();
    s = await start(h);
    expect(await (await back(h, s.callback, s.cookie)).text()).toContain("disabled");
  });

  it("refuses a name another user has, in any case, instead of numbering it", async () => {
    const h = setUp();
    issuer.idTokenClaims = { ...issuer.idTokenClaims, preferred_username: "OWNER" };
    const { cookie, callback } = await start(h);
    const response = await back(h, callback, cookie);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("already taken");
    expect(
      h.t.db
        .select()
        .from(users)
        .all()
        .filter((u) => u.oidcSubject !== null),
    ).toEqual([]);
  });

  it("stores an email only once the IdP verified it", async () => {
    const h = setUp();
    issuer.idTokenClaims = { ...issuer.idTokenClaims, email_verified: false };
    const { cookie, callback } = await start(h);
    await back(h, callback, cookie);
    expect(dana(h)?.email).toBeNull();
  });

  it.each(["//evil.example/", "/\\evil.example/x", "/\t/evil.example/x", "https://evil.example/"])(
    "goes only to a path on this site afterwards, never %j",
    (next) => {
      expect(safeNext(next, PUBLIC_URL)).toBe("/approvals");
    },
  );

  it("keeps a plain path, with its query", () => {
    expect(safeNext("/activity?agent=x", PUBLIC_URL)).toBe("/activity?agent=x");
  });

  it("refuses more sign-ins than it will hold at once", async () => {
    const h = setUp();
    const expiresAt = new Date(h.clock.now.getTime() + 600_000);
    h.t.db
      .insert(oidcSignIns)
      .values(
        Array.from({ length: MAX_PENDING }, (_, i) => ({
          id: `x${i}`,
          state: "s",
          nonce: "n",
          codeVerifier: "v",
          next: "/",
          expiresAt,
        })),
      )
      .run();
    expect((await h.fetch("/auth/oidc")).status).toBe(503);
  });

  it("doesn't take passkey sign-ins on a team install", async () => {
    const h = setUp();
    const response = await h.fetch("/sign-in", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(404);
  });
});
