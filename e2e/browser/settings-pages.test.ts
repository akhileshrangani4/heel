import { describe, expect, it } from "vitest";
import { ALL_STORIES } from "../../src/web/ui/preview/stories.ts";
import { clipped, PHONES, previewBrowser, sideways, type Win } from "./preview-browser.ts";

/**
 * The settings pages (Rules, Agents, Pause, Devices, People, Modes, Grants,
 * Standing approvals) in a real browser at phone widths, over the preview
 * harness's fixture stories: no page scrolls sideways, and long names,
 * dates and menus fit where they can be seen.
 */

const SETTINGS = new Set([
  "rules",
  "rule-history",
  "agents",
  "pause-control",
  "devices",
  "people",
  "modes",
  "grants",
  "standing-approvals",
]);
const STORIES = ALL_STORIES.filter((s) => SETTINGS.has(s.component)).map(
  (s) => `/${s.component}/${s.state}`,
);
const WIDTHS = [...PHONES, 768] as const;

const { open } = previewBrowser();

describe("settings pages at phone and tablet widths", () => {
  for (const width of WIDTHS) {
    it.each(STORIES)(`%s fits a ${String(width)}px screen`, async (path) => {
      const page = await open(path, width);
      try {
        expect(await sideways(page)).toBe(0);
      } finally {
        await page.context().close();
      }
    });
  }
});

describe("People", () => {
  it("fits long names and emails in each person's row, with no sideways scroll", async () => {
    for (const width of PHONES) {
      const page = await open("/people/long-names", width);
      try {
        const extra = await page
          .locator(".table-scroll")
          .evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(extra, `at ${String(width)}`).toBe(0);
      } finally {
        await page.context().close();
      }
    }
  });

  it("pads each stacked person row once, not again in every cell", async () => {
    const page = await open("/people/admin", 390);
    try {
      const pads = await page.evaluate(() => {
        const w = globalThis as unknown as Win;
        return [...w.document.querySelectorAll("table.person-table tbody tr > *")].map(
          (cell) => w.getComputedStyle(cell).padding,
        );
      });
      expect(new Set(pads)).toEqual(new Set(["0px"]));
    } finally {
      await page.context().close();
    }
  });

  it("opens each person's menu on screen", async () => {
    for (const width of PHONES) {
      const page = await open("/people/admin", width);
      try {
        const menus = page.locator(".set-menu > summary");
        for (let i = 0; i < (await menus.count()); i++) {
          await menus.nth(i).click();
          const panel = page.locator(".set-menu[open] .set-menu-panel");
          expect(await clipped(panel), `menu ${String(i)} at ${String(width)}`).toEqual([]);
          await menus.nth(i).click();
        }
      } finally {
        await page.context().close();
      }
    }
  });
});

describe("Modes", () => {
  it("shows each person's mode and what applies without a sideways scroll on a phone", async () => {
    for (const path of ["/modes/mixed", "/modes/watch-fallback"]) {
      for (const width of PHONES) {
        const page = await open(path, width);
        try {
          const extra = await page
            .locator(".table-scroll")
            .evaluate((el) => el.scrollWidth - el.clientWidth);
          expect(extra, `${path} at ${String(width)}`).toBe(0);
        } finally {
          await page.context().close();
        }
      }
    }
  });
});

describe("Agents", () => {
  it("fits an agent's manage menu on a phone, even for a 64-character name", async () => {
    for (const path of ["/agents/busy", "/agents/long-names"]) {
      for (const width of PHONES) {
        const page = await open(path, width);
        try {
          await page.locator(".row-manage > summary").first().click();
          const panel = page.locator(".row-manage[open] .row-manage-panel");
          expect(await clipped(panel), `${path} at ${String(width)}`).toEqual([]);
          expect(await panel.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
          expect(await sideways(page)).toBe(0);
        } finally {
          await page.context().close();
        }
      }
    }
  });
});

describe("dates", () => {
  it("never breaks a date across two lines", async () => {
    for (const path of ["/pause-control/long-names", "/standing-approvals/long-names"]) {
      for (const width of PHONES) {
        const page = await open(path, width);
        try {
          const broken = await page.evaluate(() =>
            [...(globalThis as unknown as Win).document.querySelectorAll("main time")]
              .filter((t) => t.getClientRects().length > 1)
              .map((t) => t.textContent),
          );
          expect(broken, `${path} at ${String(width)}`).toEqual([]);
        } finally {
          await page.context().close();
        }
      }
    }
  });
});

describe("Grants", () => {
  it("keeps a long agent name inside the New grant dialog, closed and open", async () => {
    for (const width of PHONES) {
      const page = await open("/grants/long-names", width);
      try {
        await page.locator('button[aria-controls="grant-dialog"]').click();
        const panel = page.locator("#grant-dialog .ui-dialog-panel");
        const sidewaysIn = () => panel.evaluate((el) => el.scrollWidth - el.clientWidth);
        expect(await sidewaysIn(), `closed at ${String(width)}`).toBe(0);
        await page.locator("#grant-dialog .ui-select-trigger").first().click();
        expect(await sidewaysIn(), `open at ${String(width)}`).toBe(0);
        expect(await clipped(page.locator(".ui-select-content:not([hidden])"))).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  });
});
