import { describe, expect, it } from "vitest";
import { createEnrollment } from "../../src/web/passkeys.ts";
import { SoftAuthenticator } from "../helpers/authenticator.ts";
import { humanPlaneHarness, issued, PUBLIC_URL } from "../helpers/human-plane.ts";

/**
 * Roadmap 2.7: making a passkey signs you in and lands on a page that turns
 * on notifications for this device, with the iPhone Home Screen step.
 */
describe("after enrolling a passkey", () => {
  it("signs in and offers notifications on the welcome page", async () => {
    const h = humanPlaneHarness();
    const link = createEnrollment(h.t.db, {
      orgId: h.t.orgId,
      userName: "owner",
      publicUrl: PUBLIC_URL,
      now: h.clock.now,
    });
    const path = new URL(link.url).pathname;
    const json = (body: unknown) => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const options = await issued(await h.fetch(`${path}/options`, json({})));
    const done = await h.fetch(
      path,
      json({
        challengeId: options.challengeId,
        response: new SoftAuthenticator().register(options.options, PUBLIC_URL.origin),
      }),
    );
    expect(await done.json()).toEqual({ ok: true, next: "/welcome" });
    const cookie = (done.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect(cookie).not.toBe("");

    const page = await (await h.fetch("/welcome", { headers: { cookie } })).text();
    expect(page).toContain("Your passkey is ready");
    expect(page).toContain("Turn on notifications");
    expect(page).toContain("Add to Home Screen");
    expect(page).toContain("No device gets notifications yet.");
    // Without the session, the page sends you to sign in.
    expect((await h.fetch("/welcome")).status).toBe(303);
  });
});
