import { describe, expect, it } from "vitest";
import { STYLESHEET } from "../../src/web/ui/theme.ts";
import { humanPlaneHarness } from "../helpers/human-plane.ts";

/**
 * Phone widths (T5): a table wider than the screen scrolls inside its own
 * region instead of widening the page, and the navigation wraps instead of
 * hiding links in a sideways scroll.
 */

const PAGES = [
  "approvals",
  "activity",
  "agents",
  "standing",
  "pause",
  "connections",
  "grants",
  "modes",
];

describe("pages at phone width", () => {
  it("puts every data table inside a scroll region", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    for (const path of PAGES) {
      const page = await (await h.fetch(`/${path}`, { as: admin })).text();
      const tables = page.match(/<table class="data"/g)?.length ?? 0;
      const wrapped =
        page.match(/<div class="table-scroll"[^>]*>\s*<table class="data"/g)?.length ?? 0;
      expect({ path, wrapped }).toEqual({ path, wrapped: tables });
    }
  });

  it("wraps the navigation, scrolls preformatted text, and pins the decision bar without covering the page", () => {
    expect(STYLESHEET).toContain(".site nav ul{display:flex;flex-wrap:wrap;");
    expect(STYLESHEET).not.toMatch(/\.site nav\{[^}]*overflow-x/);
    expect(STYLESHEET).toContain("pre{overflow-x:auto;max-width:100%}");
    // Phones: the shared bar is pinned in the tab bar's place, and the page keeps room for it.
    expect(STYLESHEET).toMatch(
      /body\.app:has\(\.ap\[data-dock="pinned"\] \.ap-bar\[data-dock\]\)\{padding-bottom:calc\(5rem/,
    );
    // Only wide screens let the call page's decision stick to the bottom of the window.
    expect(STYLESHEET).toContain("@media (min-width:56rem){.ap-decide{position:sticky");
    expect(STYLESHEET.match(/\.ap-decide\{[^}]*position:/g)).toHaveLength(1);
  });
});

describe("the top menu (1.11)", () => {
  it("shows six sections, and the section's pages as tabs", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/grants", { as: admin })).text();
    const main = page.match(/<nav aria-label="Main">[\s\S]*?<\/nav>/)?.[0] ?? "";
    // Six sections, plus More, which holds Connections and Settings on a phone.
    expect(main.match(/<li[ >]/g)).toHaveLength(7);
    expect(main).toMatch(/aria-current="page"[^>]*>[\s\S]*?nav-label">Agents</);
    const tabs = page.match(/<nav class="subnav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(tabs).toContain(">Standing approvals<");
    expect(tabs).toMatch(/aria-current="page"\s*>Grants</);
    // Your rules and their history sit beside Activity.
    const activity = await (await h.fetch("/activity", { as: admin })).text();
    const activityTabs = activity.match(/<nav class="subnav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(activityTabs).toContain(">Rules<");
    expect(activityTabs).toContain(">Rule history<");
  });
});

describe("the Connections page (1.11)", () => {
  it("shows one next step per card, and none for a ready account", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/connections", { as: admin })).text();
    // Harness accounts are active: no setup hint, no dead-end "set up with heel connect".
    expect(page).not.toContain("Needs your Google OAuth client");
    expect(page).not.toContain("Set up with");
    expect(page).toContain('class="conn" data-alias="gmail-work"');
    expect(page).toContain("Add a connection");
  });
});

describe("notices from a link (red-team round 3)", () => {
  it("don't show words a crafted link puts in the query", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const phish = "Your passkey was revoked. Call IT on +1-555-0100";
    const conn = await (
      await h.fetch(`/connections?account=gmail-work&failed=${encodeURIComponent(phish)}`, {
        as: admin,
      })
    ).text();
    expect(conn).not.toContain("Call IT");
    const fake = await (
      await h.fetch(`/connections?account=${encodeURIComponent("evil. Click here")}&connected=1`, {
        as: admin,
      })
    ).text();
    expect(fake).not.toContain("Click here");
    const pause = await (
      await h.fetch(
        `/pause?done=resumed&scope=agent&target=${encodeURIComponent("every agent. All calls run without approval now")}`,
        { as: admin },
      )
    ).text();
    expect(pause).not.toContain("All calls run without approval");
    // A real target still gets its notice.
    expect(
      await (
        await h.fetch("/pause?done=paused&scope=agent&target=inbox-bot", { as: admin })
      ).text(),
    ).toContain("Paused agent inbox-bot");
  });
});
