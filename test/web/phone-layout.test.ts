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

  it("wraps the navigation, scrolls preformatted text, and lets an open decision bar scroll away", () => {
    expect(STYLESHEET).toContain(".site nav ul{display:flex;flex-wrap:wrap;");
    expect(STYLESHEET).not.toMatch(/\.site nav\{[^}]*overflow-x/);
    expect(STYLESHEET).toContain("pre{overflow-x:auto;max-width:100%}");
    expect(STYLESHEET).toContain(".ap-decide:has(.ap-more[open]){position:static}");
  });
});

describe("the top menu (1.11)", () => {
  it("shows five sections, and the section's pages as tabs", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const page = await (await h.fetch("/grants", { as: admin })).text();
    const main = page.match(/<nav aria-label="Main">[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(main.match(/<li>/g)).toHaveLength(5);
    expect(main).toMatch(/aria-current="page"\s*>Agents</);
    const tabs = page.match(/<nav class="subnav"[\s\S]*?<\/nav>/)?.[0] ?? "";
    expect(tabs).toContain(">Standing approvals<");
    expect(tabs).toMatch(/aria-current="page"\s*>Grants</);
    // A section with one page has no tabs.
    expect(await (await h.fetch("/activity", { as: admin })).text()).not.toContain(
      'class="subnav"',
    );
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
    expect(page).toContain('class="card conn" data-alias="gmail-work"');
    expect(page).toContain("Connect another account");
  });
});
