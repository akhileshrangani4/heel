import { describe, expect, it } from "vitest";
import { createEnrollment } from "../../src/web/passkeys.ts";
import { SoftAuthenticator } from "../helpers/authenticator.ts";
import { humanPlaneHarness, issued, PUBLIC_URL } from "../helpers/human-plane.ts";

/**
 * Error pages: installed to a Home Screen heel has no back button, so a
 * browser that hits a missing page, a stale form or an ended session gets
 * a page with a way back, never a bare line of text or JSON.
 */

const PAGE = { accept: "text/html,application/xhtml+xml" };
const FORM = { ...PAGE, "content-type": "application/x-www-form-urlencoded" };

describe("error pages", () => {
  it("shows a page with a way Home for an unknown address, and text to a script", async () => {
    const h = humanPlaneHarness();
    const page = await h.fetch("/no-such-page", { headers: PAGE });
    expect(page.status).toBe(404);
    const body = await page.text();
    expect(body).toContain("<h1>Page not found</h1>");
    expect(body).toContain('href="/">Go to Home</a>');
    expect(body).toContain('<html lang="en"');

    const script = await h.fetch("/no-such-page");
    expect(script.status).toBe(404);
    expect(script.headers.get("content-type")).toContain("text/plain");
  });

  it("refuses a stale form with a page, and still refuses it", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const response = await h.fetch("/sign-out", {
      method: "POST",
      as: admin,
      headers: FORM,
      body: "csrf=wrong",
    });
    expect(response.status).toBe(403);
    const body = await response.text();
    expect(body).toContain("This form is out of date");
    expect(body).toContain("Go to Home");
    // Still signed in: the stale form did nothing.
    expect((await h.fetch("/activity", { as: admin })).status).toBe(200);
  });

  it("sends a form post with an ended session to sign in, and says the session ended", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const cookie = admin.cookie.replace(/=.*/, "=no-such-session");
    const post = await h.fetch("/sign-out", {
      method: "POST",
      headers: { ...FORM, cookie },
      body: `csrf=${admin.csrf}`,
    });
    expect(post.status).toBe(303);
    expect(post.headers.get("location")).toBe("/sign-in?next=%2F&expired");

    const get = await h.fetch("/activity", { headers: { ...PAGE, cookie } });
    expect(get.headers.get("location")).toBe("/sign-in?next=%2Factivity&expired");
    const signIn = await (await h.fetch(get.headers.get("location") ?? "")).text();
    expect(signIn).toContain("Your session ended. Sign in again to continue.");

    // A script's request still gets a 401 it can read.
    const script = await h.fetch("/approvals/folds", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: "{}",
    });
    expect(script.status).toBe(401);
  });

  it("answers an unknown, used or expired enroll link with the same 404 page", async () => {
    const h = humanPlaneHarness();
    const live = (userName: string) =>
      new URL(
        createEnrollment(h.t.db, {
          orgId: h.t.orgId,
          userName,
          publicUrl: PUBLIC_URL,
          now: h.clock.now,
        }).url,
      ).pathname;
    // A link past its 15 minutes.
    const expired = live("owner");
    expect((await h.fetch(expired, { headers: PAGE })).status).toBe(200);
    h.clock.advance(16 * 60_000);

    // A link that made a passkey.
    const used = live("owner");
    expect((await h.fetch(used, { headers: PAGE })).status).toBe(200);
    const json = (body: unknown): RequestInit => ({
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const options = await issued(await h.fetch(`${used}/options`, json({})));
    const enrolled = await h.fetch(
      used,
      json({
        challengeId: options.challengeId,
        response: new SoftAuthenticator().register(options.options, PUBLIC_URL.origin),
      }),
    );
    expect(enrolled.status).toBe(200);

    const answers = await Promise.all(
      ["/enroll/enr_never_issued", used, expired].map(async (path) => {
        const response = await h.fetch(path, { headers: PAGE });
        return { status: response.status, body: await response.text() };
      }),
    );
    for (const answer of answers) {
      expect(answer.status).toBe(404);
      expect(answer.body).toContain("This link can't be used");
      expect(answer.body).toContain('href="/">Go to Home</a>');
      expect(answer.body).not.toContain("Create a passkey");
    }
    // Word for word the same: the page never tells which kind of link it was.
    expect(new Set(answers.map((a) => a.body)).size).toBe(1);
  });

  it("says nothing about an ended session to a browser that never signed in", async () => {
    const h = humanPlaneHarness();
    const get = await h.fetch("/activity", { headers: PAGE });
    expect(get.headers.get("location")).toBe("/sign-in?next=%2Factivity");
  });
});
