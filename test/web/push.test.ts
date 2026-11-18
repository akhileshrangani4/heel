import { describe, expect, it } from "vitest";
import { findPushSubscription, pushSubscriptionsOf } from "../../src/store/notifications.ts";
import { humanPlaneHarness, TEST_VAPID_PUBLIC_KEY } from "../helpers/human-plane.ts";

/**
 * The installable approval page and device subscriptions (spec:
 * Notifications): what a phone needs to install heel and receive pushes.
 */

const SUBSCRIPTION = {
  endpoint: "https://push.example.com/send/phone-1",
  // Placeholder values in the base64url alphabet; not real keys.
  keys: { p256dh: "test-p256dh-key", auth: "test-auth-secret" },
};

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

describe("the installable approval page", () => {
  it("serves a manifest, a service worker and the app icon without signing in", async () => {
    const h = humanPlaneHarness();

    const manifest = await h.fetch("/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect(await manifest.json()).toMatchObject({
      name: "heel",
      start_url: "/approvals",
      display: "standalone",
    });

    const worker = await h.fetch("/sw.js");
    expect(worker.headers.get("content-type")).toMatch(/javascript/);
    // A tap only ever opens a page on heel's own origin.
    expect(await worker.text()).toContain("startsWith(self.location.origin)");

    const icon = await h.fetch("/icon-180.png");
    expect(icon.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await icon.arrayBuffer()).subarray(1, 4)).toEqual(
      new TextEncoder().encode("PNG"),
    );
  });

  it("offers to turn on notifications on the approvals page, with the install's VAPID key", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());

    const page = await (await h.fetch("/approvals", { as: owner })).text();

    expect(page).toContain("Turn on notifications");
    expect(page).toContain(`data-key="${TEST_VAPID_PUBLIC_KEY}"`);
    expect(page).toContain('rel="manifest"');
  });
});

describe("device subscriptions", () => {
  it("stores a signed-in person's device, and lets them remove it", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());

    expect(
      (await h.fetch("/push/subscribe", { as: owner, ...postJson(SUBSCRIPTION) })).status,
    ).toBe(200);
    expect(pushSubscriptionsOf(h.t.db, h.t.ownerId)).toMatchObject([
      {
        endpoint: SUBSCRIPTION.endpoint,
        p256dh: SUBSCRIPTION.keys.p256dh,
        auth: SUBSCRIPTION.keys.auth,
      },
    ]);

    await h.fetch("/push/unsubscribe", {
      as: owner,
      ...postJson({ endpoint: SUBSCRIPTION.endpoint }),
    });
    expect(findPushSubscription(h.t.db, SUBSCRIPTION.endpoint)).toBeNull();
  });

  it("refuses a subscription without a session or without the page's CSRF token", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());

    expect((await h.fetch("/push/subscribe", postJson(SUBSCRIPTION))).status).toBe(401);
    expect(
      (await h.fetch("/push/subscribe", { as: owner, csrf: false, ...postJson(SUBSCRIPTION) }))
        .status,
    ).toBe(403);
    expect(findPushSubscription(h.t.db, SUBSCRIPTION.endpoint)).toBeNull();
  });

  it.each([
    ["a non-https endpoint", { ...SUBSCRIPTION, endpoint: "http://push.example.com/1" }],
    ["missing keys", { endpoint: SUBSCRIPTION.endpoint }],
    ["keys that aren't base64url", { ...SUBSCRIPTION, keys: { p256dh: "<script>", auth: "x" } }],
  ])("refuses %s", async (_label, body) => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());

    expect((await h.fetch("/push/subscribe", { as: owner, ...postJson(body) })).status).toBe(400);
  });

  it("can't remove someone else's device", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    await h.fetch("/push/subscribe", { as: owner, ...postJson(SUBSCRIPTION) });
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));

    await h.fetch("/push/unsubscribe", {
      as: sam,
      ...postJson({ endpoint: SUBSCRIPTION.endpoint }),
    });

    expect(findPushSubscription(h.t.db, SUBSCRIPTION.endpoint)).not.toBeNull();
  });
});
