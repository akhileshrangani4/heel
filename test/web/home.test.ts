import { describe, expect, it } from "vitest";
import { accounts } from "../../src/store/schema.ts";
import { humanPlaneHarness } from "../helpers/human-plane.ts";

/** The Home dashboard: what needs you across heel, at `/`. */
describe("the Home page", () => {
  it("sends a signed-out visitor to sign in, and back to Home after", async () => {
    const h = humanPlaneHarness();
    const response = await h.fetch("/");
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/sign-in?next=%2F");
  });

  it("shows a tile per area, each linking to its page, flagged only when something needs you", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/", { as: owner })).text();
    expect(page).toContain("<title>Home · heel</title>");
    expect(page).toMatch(
      /<nav aria-label="Main">[\s\S]*aria-current="page"[^>]*>[\s\S]*?nav-label">Home</,
    );
    for (const href of ["/approvals", "/agents", "/connections", "/rules"]) {
      expect(page).toContain(`class="home-tile" href="${href}"`);
    }
    // Nothing waits and the harness accounts are all active: no tile is flagged.
    expect(page).not.toMatch(/class="home-tile" href="[^"]*" data-alert=/);
    expect(page).toContain("All ready");
  });

  it("counts an account that needs signing in again", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    h.t.db.update(accounts).set({ status: "reconnect_required" }).run();
    const page = await (await h.fetch("/", { as: owner })).text();
    // One sentence says it; no badge repeats it.
    expect(page).toMatch(/\d+ needs? signing in again/);
    expect(page).toMatch(/class="home-tile" href="\/connections" data-alert="warn"/);
  });

  it("lists the setup steps left, linked to where they're done", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/", { as: owner })).text();
    expect(page).toContain("Get set up");
    // Signed in with a passkey, harness accounts exist and inbox-bot is an agent; no notifications yet.
    expect(page).toMatch(/<li data-done="yes">\s*<a href="\/devices#device-heading">/);
    expect(page).toContain('Add a passkey<span class="visually-hidden"> (done)</span>');
    expect(page).toMatch(/<li data-done="no">\s*<a href="\/devices#push-heading">/);
    expect(page).toContain("3 of 4 done");
  });

  it("charts the week's calls and lists the latest decisions in words", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    await h.call();
    const page = await (await h.fetch("/", { as: owner })).text();
    expect(page).toContain("Calls in the last 7 days");
    expect(page).toMatch(/aria-label="Calls per day: [^"]* 1"/);
    expect(page).toContain("<strong>inbox-bot</strong> wanted to");
    expect(page).toContain('<a class="home-more" href="/activity">View all');
  });

  it("shows an empty state instead of an empty chart before any call", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/", { as: owner })).text();
    expect(page).toContain("No calls yet");
    expect(page).not.toContain('class="home-spark"');
  });
});
