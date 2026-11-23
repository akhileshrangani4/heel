import { describe, expect, it } from "vitest";
import { builtInGoogleClient } from "../../../src/definitions/google/builtin.ts";
import { findAccount } from "../../../src/store/directory.ts";
import { connectAccount } from "../../../src/vault/connect.ts";
import { loopbackSignInPage } from "../../../src/web/ui/loopback-sign-in.ts";
import { FakeGoogle, TEST_GOOGLE_CLIENT } from "../../helpers/fake-google.ts";
import { humanPlaneHarness } from "../../helpers/human-plane.ts";

/**
 * heel's built-in Google client (roadmap 1.14): no `providers.google`, a
 * loopback redirect on heel's host, and a paste-back for browsers elsewhere.
 */

const BUILT_IN = {
  clientId: TEST_GOOGLE_CLIENT.clientId,
  clientSecret: TEST_GOOGLE_CLIENT.clientSecret,
};

function setUp() {
  const google = new FakeGoogle();
  const h = humanPlaneHarness({ upstreamOAuth: { fetch: google.fetch }, builtInGoogle: BUILT_IN });
  connectAccount(
    h.t.db,
    h.vault,
    { orgId: h.t.orgId, ownerId: h.t.ownerId, provider: "gmail", alias: "gmail-home" },
    new Date(),
  );
  return { h, google };
}

type Harness = ReturnType<typeof setUp>["h"];
type Browser = Awaited<ReturnType<Harness["signIn"]>>;

const form = (fields: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(fields).toString(),
});

/** Starts a sign-in; returns Google's URL and the sign-in's state, from the page heel shows. */
async function start(h: Harness, as: Browser) {
  const page = await h.fetch("/connections/sign-in", {
    as,
    ...form({ csrf: as.csrf, alias: "gmail-home" }),
  });
  expect(page.status).toBe(200);
  const text = await page.text();
  const google = /href="(https:\/\/accounts\.google\.com[^"]+)"/
    .exec(text)?.[1]
    ?.replaceAll("&amp;", "&");
  const state = /name="state" value="([^"]+)"/.exec(text)?.[1];
  if (google === undefined || state === undefined) throw new Error("no Google link on the page");
  return { google, state, text };
}

const account = (h: Harness) => findAccount(h.t.db, h.t.orgId, "gmail-home");

describe("Gmail with heel's built-in Google client", () => {
  it("is ready to sign in with no providers.google", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/connections", { as: owner })).text();
    expect(page).not.toContain("providers.google");
    expect(page).toContain("Sign in");
  });

  it("on heel's host: Google comes back to the loopback listener, which hands over to heel", async () => {
    const { h, google } = setUp();
    const owner = await h.signIn(await h.enroll());
    const { google: authorize } = await start(h, owner);
    const redirect = new URL(new URL(authorize).searchParams.get("redirect_uri") ?? "");
    expect(redirect.hostname).toBe("127.0.0.1");
    expect(redirect.pathname).toBe("/");

    // The browser follows Google back to the listener, which only forwards.
    const callback = google.consent(authorize);
    const forwarded = await fetch(`${callback}&extra=dropped`, { redirect: "manual" });
    expect(forwarded.status).toBe(302);
    expect(forwarded.headers.get("cache-control")).toBe("no-store");
    const location = new URL(forwarded.headers.get("location") ?? "");
    expect(location.pathname).toBe("/connections/google/return");
    expect(location.searchParams.has("code")).toBe(true);
    expect(location.searchParams.has("extra")).toBe(false);

    // A top-level redirect from Google's side: the Lax session cookie comes with it.
    const landed = await h.fetch(location.pathname + location.search, { as: owner });
    expect(landed.headers.get("location")).toContain("connected=1");
    expect(account(h)?.status).toBe("active");
    // The tokens remember which client issued them, so they refresh with it.
    const stored = h.vault.get(account(h)?.id ?? "");
    expect(stored.type).toBe("oauth");

    // The listener is gone once the sign-in finished.
    await expect(fetch(callback.toString())).rejects.toThrow();
  });

  it("elsewhere: the person pastes the address that didn't load, and it finishes the same way", async () => {
    const { h, google } = setUp();
    const owner = await h.signIn(await h.enroll());
    const { google: authorize, state } = await start(h, owner);
    const callback = google.consent(authorize);

    const pasted = await h.fetch("/connections/google/paste", {
      as: owner,
      ...form({ csrf: owner.csrf, state, address: callback.toString() }),
    });
    expect(pasted.status).toBe(303);
    const next = pasted.headers.get("location") ?? "";
    expect(next.startsWith("/connections/google/return?")).toBe(true);
    const landed = await h.fetch(next, { as: owner });
    expect(landed.headers.get("location")).toContain("connected=1");
    expect(account(h)?.status).toBe("active");
  });

  it("on a server: leads with copying the address back, with a paste-and-finish button", async () => {
    const { h } = setUp();
    const owner = await h.signIn(await h.enroll());
    const { text } = await start(h, owner);
    expect(text).toContain("heel runs on another machine");
    expect(text).toContain('id="paste-finish"');
    expect(text).not.toContain("On the computer heel runs on");
    const local = String(
      loopbackSignInPage({
        alias: "gmail-home",
        google: "https://accounts.google.com/o/oauth2/v2/auth",
        paste: { action: "/connections/google/paste", csrfToken: "t" },
        state: "s",
        remote: false,
      }),
    );
    expect(local).toContain("On the computer heel runs on");
    expect(local).toContain('id="paste-finish"');
  });

  it("Paste and finish finds the address in what was copied, scheme or not", () => {
    const page = String(
      loopbackSignInPage({
        alias: "gmail-home",
        google: "https://accounts.google.com/o/oauth2/v2/auth",
        paste: { action: "/connections/google/paste", csrfToken: "t" },
        state: "s",
        remote: true,
      }),
    );
    const script = /<script>([\s\S]*?)<\/script>/.exec(page)?.[1] ?? "";
    expect(() => new Function(script)).not.toThrow();
    const body = /const find = \(text\) => \{([\s\S]*?)\n {2}\};/.exec(page)?.[1] ?? "";
    const find = new Function("text", body) as (text: string) => string | null;
    expect(find("http://127.0.0.1:5555/?state=s&code=1")).toBe(
      "http://127.0.0.1:5555/?state=s&code=1",
    );
    expect(find("\u200e127.0.0.1:5555/?state=s&code=1\n")).toBe("127.0.0.1:5555/?state=s&code=1");
    expect(find("https://evil.example/?state=s")).toBeNull();
  });

  it("takes a pasted address that lost its http://", async () => {
    const { h, google } = setUp();
    const owner = await h.signIn(await h.enroll());
    const { google: authorize, state } = await start(h, owner);
    const callback = google
      .consent(authorize)
      .toString()
      .replace(/^http:\/\//, "");
    const pasted = await h.fetch("/connections/google/paste", {
      as: owner,
      ...form({ csrf: owner.csrf, state, address: ` ${callback} ` }),
    });
    const next = pasted.headers.get("location") ?? "";
    expect(next.startsWith("/connections/google/return?")).toBe(true);
    const landed = await h.fetch(next, { as: owner });
    expect(landed.headers.get("location")).toContain("connected=1");
  });

  it("refuses a pasted address for another listener, and from someone else", async () => {
    const { h, google } = setUp();
    const owner = await h.signIn(await h.enroll());
    const { google: authorize, state } = await start(h, owner);
    const callback = google.consent(authorize);

    const elsewhere = new URL(callback);
    elsewhere.host = "evil.example";
    const wrongOrigin = await h.fetch("/connections/google/paste", {
      as: owner,
      ...form({ csrf: owner.csrf, state, address: elsewhere.toString() }),
    });
    expect(wrongOrigin.headers.get("location")).toContain("failed=");

    h.addUser("sam", "admin");
    const sam = await h.signIn(await h.enroll("sam"));
    const notTheirs = await h.fetch("/connections/google/paste", {
      as: sam,
      ...form({ csrf: sam.csrf, state, address: callback.toString() }),
    });
    expect(notTheirs.headers.get("location")).toContain("failed=");
    expect(account(h)?.status).not.toBe("active");
  });

  it("an operator's own client still wins", async () => {
    const google = new FakeGoogle();
    const h = humanPlaneHarness({
      upstreamOAuth: { fetch: google.fetch },
      providerClients: { google: TEST_GOOGLE_CLIENT },
      builtInGoogle: BUILT_IN,
    });
    connectAccount(
      h.t.db,
      h.vault,
      { orgId: h.t.orgId, ownerId: h.t.ownerId, provider: "gmail", alias: "gmail-home" },
      new Date(),
    );
    const owner = await h.signIn(await h.enroll());
    const started = await h.fetch("/connections/sign-in", {
      as: owner,
      ...form({ csrf: owner.csrf, alias: "gmail-home" }),
    });
    expect(started.status).toBe(303);
    expect(started.headers.get("location")).toContain(
      encodeURIComponent("https://heel.example.com/oauth/google/callback"),
    );
  });
});

describe("builtInGoogleClient", () => {
  it("is off in a build without heel's client", () => {
    expect(builtInGoogleClient({ clientId: "", clientSecret: "" })).toBeNull();
    expect(builtInGoogleClient({ clientId: "id", clientSecret: "s" })?.clientId).toBe("id");
  });
});
