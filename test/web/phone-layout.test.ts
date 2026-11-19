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
