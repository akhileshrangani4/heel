import { createHash } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { RoleGroups } from "../../src/config/schema.ts";
import {
  displayName,
  OIDC_CLIENT_SECRET_ENV,
  OidcClient,
  OidcError,
  type OidcErrorCode,
  type OidcSettings,
  oidcSettings,
  SIGN_IN_TTL_MS,
} from "../../src/teams/oidc.ts";
import { readGroupsClaim, roleForGroups } from "../../src/teams/roles.ts";
import { Secret } from "../../src/vault/secret.ts";
import { SecretFileError } from "../../src/vault/secret-file.ts";
import { MockIssuer } from "../helpers/oidc-issuer.ts";
import { tempDir } from "../helpers/store.ts";

const ROLES: RoleGroups = { admin: ["heel-admins"], member: ["engineering", "support"] };

function settingsFor(issuer: MockIssuer, overrides: Partial<OidcSettings> = {}): OidcSettings {
  return {
    issuer: issuer.url,
    clientId: "heel-test",
    redirectUri: new URL("https://heel.example.com/auth/oidc/callback"),
    scopes: ["openid", "profile", "email"],
    groupsClaim: "groups",
    roles: ROLES,
    clientSecret: null,
    ...overrides,
  };
}

async function expectOidcError(promise: Promise<unknown>, code: OidcErrorCode): Promise<OidcError> {
  const error = await promise.then(
    () => {
      throw new Error(`expected OidcError ${code}, but the call succeeded`);
    },
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(OidcError);
  expect((error as OidcError).code).toBe(code);
  return error as OidcError;
}

describe("OIDC client against a mock issuer", () => {
  let issuer: MockIssuer;

  beforeEach(async () => {
    issuer = await MockIssuer.start();
  });
  afterEach(async () => {
    await issuer.close();
  });

  it("PKCE is used: the authorization request carries an S256 challenge of the stored verifier", async () => {
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    const params = authorizationUrl.searchParams;

    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      `${issuer.url.origin}/authorize`,
    );
    expect(params.get("response_type")).toBe("code");
    expect(params.get("client_id")).toBe("heel-test");
    expect(params.get("redirect_uri")).toBe("https://heel.example.com/auth/oidc/callback");
    expect(params.get("scope")).toBe("openid profile email");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("code_challenge")).toBe(
      createHash("sha256").update(pending.codeVerifier).digest("base64url"),
    );
    expect(params.get("state")).toBe(pending.state);
    expect(params.get("nonce")).toBe(pending.nonce);
    // The verifier itself never leaves heel in the front channel.
    expect(authorizationUrl.href).not.toContain(pending.codeVerifier);
  });

  it("each sign-in gets a fresh verifier, state and nonce", async () => {
    const client = await OidcClient.discover(settingsFor(issuer));
    const first = (await client.beginSignIn()).pending;
    const second = (await client.beginSignIn()).pending;
    expect(second.codeVerifier).not.toBe(first.codeVerifier);
    expect(second.state).not.toBe(first.state);
    expect(second.nonce).not.toBe(first.nonce);
  });

  it("completes a sign-in, sending the PKCE verifier to the token endpoint, and maps groups to a role", async () => {
    issuer.idTokenClaims = {
      groups: ["heel-admins", "engineering"],
      preferred_username: "alice",
      email: "alice@example.com",
    };
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();

    const identity = await client.completeSignIn(issuer.authorize(authorizationUrl), pending);

    expect(identity).toEqual({
      issuer: issuer.url.origin,
      subject: "user-123",
      name: "alice",
      email: "alice@example.com",
      groups: ["heel-admins", "engineering"],
      role: "admin",
    });
    expect(issuer.tokenRequests).toHaveLength(1);
    expect(issuer.tokenRequests[0]?.form.get("code_verifier")).toBe(pending.codeVerifier);
    // A public client sends its id in the body and no client secret.
    expect(issuer.tokenRequests[0]?.form.get("client_id")).toBe("heel-test");
    expect(issuer.tokenRequests[0]?.authorization).toBeUndefined();
  });

  it("PKCE is validated: the issuer refuses a verifier that doesn't match the challenge", async () => {
    issuer.idTokenClaims = { groups: ["heel-admins"] };
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    const callback = issuer.authorize(authorizationUrl);

    const tampered = { ...pending, codeVerifier: `${pending.codeVerifier.slice(0, -1)}x` };
    await expectOidcError(client.completeSignIn(callback, tampered), "token_exchange_failed");
  });

  it("refuses an issuer that doesn't advertise S256 PKCE", async () => {
    await issuer.close();
    issuer = await MockIssuer.start({ codeChallengeMethods: ["plain"] });
    await expectOidcError(OidcClient.discover(settingsFor(issuer)), "pkce_unsupported");
    await issuer.close();
    issuer = await MockIssuer.start({ codeChallengeMethods: null });
    await expectOidcError(OidcClient.discover(settingsFor(issuer)), "pkce_unsupported");
  });

  it("reports an unreachable issuer as a discovery failure", async () => {
    const url = issuer.url;
    await issuer.close();
    await expectOidcError(
      OidcClient.discover({ ...settingsFor(issuer), issuer: url }),
      "discovery_failed",
    );
    issuer = await MockIssuer.start();
  });

  it("rejects a callback whose state doesn't match, before any token request", async () => {
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    const callback = issuer.authorize(authorizationUrl);
    callback.searchParams.set("state", "forged");

    await expectOidcError(client.completeSignIn(callback, pending), "response_invalid");
    expect(issuer.tokenRequests).toHaveLength(0);
  });

  it("rejects a callback for another sign-in's pending state", async () => {
    const client = await OidcClient.discover(settingsFor(issuer));
    const first = await client.beginSignIn();
    const second = await client.beginSignIn();
    await expectOidcError(
      client.completeSignIn(issuer.authorize(first.authorizationUrl), second.pending),
      "response_invalid",
    );
  });

  const badTokens: Array<[string, (issuer: MockIssuer) => void]> = [
    ["a wrong nonce", (i) => (i.idTokenOverrides = { nonce: "replayed" })],
    ["no nonce", (i) => (i.idTokenOverrides = { nonce: undefined })],
    ["another audience", (i) => (i.idTokenOverrides = { aud: "some-other-client" })],
    ["another issuer", (i) => (i.idTokenOverrides = { iss: "https://evil.example.com" })],
    [
      "an expired token",
      (i) => {
        const past = Math.floor(Date.now() / 1_000) - 3_600;
        i.idTokenOverrides = { iat: past - 300, exp: past };
      },
    ],
    ["a signature from a key outside the JWKS", (i) => (i.signWithForeignKey = true)],
  ];

  for (const [label, tamper] of badTokens) {
    it(`rejects an ID token with ${label}`, async () => {
      issuer.idTokenClaims = { groups: ["heel-admins"] };
      tamper(issuer);
      const client = await OidcClient.discover(settingsFor(issuer));
      const { authorizationUrl, pending } = await client.beginSignIn();
      await expectOidcError(
        client.completeSignIn(issuer.authorize(authorizationUrl), pending),
        "response_invalid",
      );
    });
  }

  it("reports an IdP error redirect (the person declined)", async () => {
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    const error = await expectOidcError(
      client.completeSignIn(issuer.deny(authorizationUrl), pending),
      "idp_error",
    );
    expect(error.message).toContain("access_denied");
  });

  it("refuses a pending sign-in older than its TTL without contacting the IdP", async () => {
    let now = new Date("2026-11-13T12:00:00Z");
    const client = await OidcClient.discover(settingsFor(issuer), { now: () => now });
    const { authorizationUrl, pending } = await client.beginSignIn();
    expect(pending.expiresAt.getTime()).toBe(now.getTime() + SIGN_IN_TTL_MS);
    const callback = issuer.authorize(authorizationUrl);

    now = new Date(pending.expiresAt.getTime());
    await expectOidcError(client.completeSignIn(callback, pending), "sign_in_expired");
    expect(issuer.tokenRequests).toHaveLength(0);
  });

  it("a code can't be redeemed twice", async () => {
    issuer.idTokenClaims = { groups: ["engineering"] };
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    const callback = issuer.authorize(authorizationUrl);
    await client.completeSignIn(callback, pending);
    await expectOidcError(client.completeSignIn(callback, pending), "token_exchange_failed");
  });

  it("roles come from groups: a member group grants member", async () => {
    issuer.idTokenClaims = { groups: ["support"] };
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    const identity = await client.completeSignIn(issuer.authorize(authorizationUrl), pending);
    expect(identity.role).toBe("member");
  });

  it("roles come from groups: no mapped group grants no role", async () => {
    issuer.idTokenClaims = { groups: ["marketing"] };
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    const identity = await client.completeSignIn(issuer.authorize(authorizationUrl), pending);
    expect(identity.groups).toEqual(["marketing"]);
    expect(identity.role).toBeNull();
  });

  it("reads groups from userinfo when the ID token omits them", async () => {
    issuer.userinfoClaims = { groups: ["engineering"] };
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    const identity = await client.completeSignIn(issuer.authorize(authorizationUrl), pending);
    expect(identity.groups).toEqual(["engineering"]);
    expect(identity.role).toBe("member");
  });

  it("with groups in neither the ID token nor userinfo, grants no role", async () => {
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    const identity = await client.completeSignIn(issuer.authorize(authorizationUrl), pending);
    expect(identity.groups).toEqual([]);
    expect(identity.role).toBeNull();
  });

  it("refuses a groups claim that isn't a list of names", async () => {
    issuer.idTokenClaims = { groups: { admin: true } };
    const client = await OidcClient.discover(settingsFor(issuer));
    const { authorizationUrl, pending } = await client.beginSignIn();
    await expectOidcError(
      client.completeSignIn(issuer.authorize(authorizationUrl), pending),
      "groups_malformed",
    );
  });

  it("follows a configured nested groups claim", async () => {
    issuer.idTokenClaims = { realm_access: { roles: ["heel-admins"] } };
    const client = await OidcClient.discover(
      settingsFor(issuer, { groupsClaim: "realm_access.roles" }),
    );
    const { authorizationUrl, pending } = await client.beginSignIn();
    const identity = await client.completeSignIn(issuer.authorize(authorizationUrl), pending);
    expect(identity.role).toBe("admin");
  });

  it("a confidential client authenticates to the token endpoint with HTTP Basic", async () => {
    await issuer.close();
    issuer = await MockIssuer.start({ clientSecret: "s3cret/with:chars" });
    issuer.idTokenClaims = { groups: ["engineering"] };
    const client = await OidcClient.discover(
      settingsFor(issuer, { clientSecret: new Secret("s3cret/with:chars") }),
    );
    const { authorizationUrl, pending } = await client.beginSignIn();
    const identity = await client.completeSignIn(issuer.authorize(authorizationUrl), pending);
    expect(identity.role).toBe("member");
    expect(issuer.tokenRequests[0]?.authorization).toMatch(/^Basic /);
    // PKCE is still sent by a confidential client.
    expect(issuer.tokenRequests[0]?.form.get("code_verifier")).toBe(pending.codeVerifier);

    const wrong = await OidcClient.discover(
      settingsFor(issuer, { clientSecret: new Secret("not-the-secret") }),
    );
    const second = await wrong.beginSignIn();
    await expectOidcError(
      wrong.completeSignIn(issuer.authorize(second.authorizationUrl), second.pending),
      "token_exchange_failed",
    );
  });
});

describe("OIDC settings", () => {
  const base = {
    issuer: new URL("https://idp.example.com"),
    clientId: "heel",
    redirectUri: new URL("https://heel.example.com/auth/oidc/callback"),
    scopes: ["openid"],
    groupsClaim: "groups",
    roles: ROLES,
  };

  it("is a public client with no secret configured", () => {
    expect(oidcSettings({ ...base, clientSecretFile: null }, {}).clientSecret).toBeNull();
  });

  it("takes the secret from the environment before the file", () => {
    const settings = oidcSettings(
      { ...base, clientSecretFile: "/nonexistent/secret" },
      { [OIDC_CLIENT_SECRET_ENV]: "from-env" },
    );
    expect(settings.clientSecret?.reveal()).toBe("from-env");
  });

  it("reads a 0600 secret file and drops its trailing newline", () => {
    const file = join(tempDir("heel-oidc-"), "client-secret");
    writeFileSync(file, "from-file\n", { mode: 0o600 });
    const settings = oidcSettings({ ...base, clientSecretFile: file }, {});
    expect(settings.clientSecret?.reveal()).toBe("from-file");
    // The secret never prints.
    expect(JSON.stringify(settings)).not.toContain("from-file");
  });

  it("refuses a secret file others can read rather than downgrading to a public client", () => {
    const file = join(tempDir("heel-oidc-"), "client-secret");
    writeFileSync(file, "from-file\n");
    chmodSync(file, 0o644);
    expect(() => oidcSettings({ ...base, clientSecretFile: file }, {})).toThrow(SecretFileError);
  });

  it("refuses a configured secret file that is missing", () => {
    expect(() =>
      oidcSettings({ ...base, clientSecretFile: "/nonexistent/heel-secret" }, {}),
    ).toThrow(SecretFileError);
  });
});

describe("group to role mapping", () => {
  it.each([
    [["heel-admins"], "admin"],
    [["engineering"], "member"],
    [["support", "heel-admins"], "admin"],
    [["marketing"], null],
    [[], null],
    [["Heel-Admins"], null],
  ] as const)("groups %j grant %s", (groups, role) => {
    expect(roleForGroups(groups, ROLES)).toBe(role);
  });

  it("reads list, single-string, nested, dotted-name and malformed claims", () => {
    expect(readGroupsClaim({ groups: ["a", "b", "a"] }, "groups")).toEqual({
      state: "present",
      groups: ["a", "b"],
    });
    expect(readGroupsClaim({ groups: "a" }, "groups")).toEqual({ state: "present", groups: ["a"] });
    expect(readGroupsClaim({ ra: { roles: ["x"] } }, "ra.roles")).toEqual({
      state: "present",
      groups: ["x"],
    });
    expect(readGroupsClaim({ "https://x.io/groups": ["y"] }, "https://x.io/groups")).toEqual({
      state: "present",
      groups: ["y"],
    });
    expect(readGroupsClaim({}, "groups")).toEqual({ state: "absent" });
    expect(readGroupsClaim({ groups: null }, "groups")).toEqual({ state: "absent" });
    expect(readGroupsClaim({ groups: [1, 2] }, "groups")).toEqual({ state: "malformed" });
    expect(readGroupsClaim({ groups: 7 }, "groups")).toEqual({ state: "malformed" });
  });

  it("doesn't read inherited properties as claims", () => {
    expect(readGroupsClaim({}, "constructor.name")).toEqual({ state: "absent" });
  });

  it("names a person by preferred_username, then name, email, sub", () => {
    expect(displayName({ preferred_username: "al", name: "Al", email: "a@x" }, "s")).toBe("al");
    expect(displayName({ name: "Al", email: "a@x" }, "s")).toBe("Al");
    expect(displayName({ email: "a@x" }, "s")).toBe("a@x");
    expect(displayName({ preferred_username: "" }, "s")).toBe("s");
  });
});
