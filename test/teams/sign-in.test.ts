import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { users } from "../../src/store/schema.ts";
import { OidcClient } from "../../src/teams/oidc.ts";
import { humanPlaneHarness, PUBLIC_URL } from "../helpers/human-plane.ts";
import { MockIssuer } from "../helpers/oidc-issuer.ts";

/** Team sign-in through the IdP (D13b), from the sign-in page to a session. */

describe("OIDC sign-in", () => {
  let issuer: MockIssuer;

  beforeEach(async () => {
    issuer = await MockIssuer.start();
    issuer.idTokenClaims = {
      groups: ["engineering"],
      preferred_username: "dana",
      email: "dana@example.com",
    };
  });
  afterEach(async () => {
    await issuer.close();
  });

  function setUp() {
    let client: Promise<OidcClient> | null = null;
    return humanPlaneHarness({
      oidc: {
        name: "Example SSO",
        client: () => {
          client ??= OidcClient.discover({
            issuer: issuer.url,
            clientId: "heel-test",
            redirectUri: new URL("/auth/oidc/callback", PUBLIC_URL),
            scopes: ["openid", "profile", "email"],
            groupsClaim: "groups",
            roles: { admin: ["heel-admins"], member: ["engineering"] },
            clientSecret: null,
          });
          return client;
        },
      },
    });
  }

  /** Starts a sign-in; returns the binding cookie and the URL the IdP sends the person back to. */
  async function start(h: ReturnType<typeof setUp>, next = "/approvals") {
    const response = await h.fetch(`/auth/oidc?next=${encodeURIComponent(next)}`);
    expect(response.status).toBe(303);
    const cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const callback = issuer.authorize(new URL(response.headers.get("location") ?? ""));
    return { cookie, callback };
  }

  const back = (h: ReturnType<typeof setUp>, callback: URL, cookie?: string) =>
    h.fetch(
      `${callback.pathname}${callback.search}`,
      cookie === undefined ? {} : { headers: { cookie } },
    );

  it("shows the organization's sign-in on a team install", async () => {
    const h = setUp();
    const page = await (await h.fetch("/sign-in")).text();
    expect(page).toContain("Sign in with Example SSO");
  });

  it("signs a person in, creating their user with the role and groups the IdP gives", async () => {
    const h = setUp();
    const { cookie, callback } = await start(h, "/activity");
    const response = await back(h, callback, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/activity");
    expect(response.headers.get("set-cookie")).toContain("__Host-heel_session=");
    const user = h.t.db.select().from(users).where(eq(users.name, "dana")).get();
    expect(user).toMatchObject({
      role: "member",
      groups: ["engineering"],
      email: "dana@example.com",
    });
    expect(user?.oidcSubject).toBe(`${issuer.url.href.replace(/\/$/, "")} user-123`);
  });

  it("reads the role again at every sign-in", async () => {
    const h = setUp();
    let s = await start(h);
    await back(h, s.callback, s.cookie);
    issuer.idTokenClaims = { ...issuer.idTokenClaims, groups: ["heel-admins"] };
    s = await start(h);
    await back(h, s.callback, s.cookie);
    expect(h.t.db.select().from(users).where(eq(users.name, "dana")).get()?.role).toBe("admin");
  });

  it("refuses someone in no mapped group", async () => {
    const h = setUp();
    issuer.idTokenClaims = { ...issuer.idTokenClaims, groups: ["sales"] };
    const { cookie, callback } = await start(h);
    const response = await back(h, callback, cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("isn&#39;t in a group");
    expect(response.headers.get("set-cookie") ?? "").not.toContain("heel_session=");
  });

  it("completes only in the browser that started it, and only once", async () => {
    const h = setUp();
    const { cookie, callback } = await start(h);
    expect((await back(h, callback)).headers.get("location")).toBeNull();
    expect((await back(h, callback, "heel_oidc=forged")).headers.get("location")).toBeNull();
    expect((await back(h, callback, cookie)).status).toBe(303);
    expect((await back(h, callback, cookie)).headers.get("location")).toBeNull();
  });

  it("refuses a disabled user", async () => {
    const h = setUp();
    let s = await start(h);
    await back(h, s.callback, s.cookie);
    h.t.db.update(users).set({ disabledAt: new Date() }).where(eq(users.name, "dana")).run();
    s = await start(h);
    expect(await (await back(h, s.callback, s.cookie)).text()).toContain("disabled");
  });

  it("never takes over a user with the same name: the person gets a name of their own", async () => {
    const h = setUp();
    issuer.idTokenClaims = { ...issuer.idTokenClaims, preferred_username: "owner" };
    const { cookie, callback } = await start(h);
    await back(h, callback, cookie);
    const named = h.t.db.select({ name: users.name, sub: users.oidcSubject }).from(users).all();
    expect(named.find((u) => u.name === "owner")?.sub ?? null).toBeNull();
    expect(named.some((u) => u.name.startsWith("owner-") && u.sub !== null)).toBe(true);
  });

  it("only goes to a path on this site afterwards", async () => {
    const h = setUp();
    const { cookie, callback } = await start(h, "//evil.example/");
    expect((await back(h, callback, cookie)).headers.get("location")).toBe("/approvals");
  });
});
