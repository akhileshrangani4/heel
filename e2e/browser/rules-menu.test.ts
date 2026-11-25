import { describe, expect, it } from "vitest";
import { clipped, previewBrowser } from "./preview-browser.ts";

/** The Rules page's decision menus open in full, even on the last rule. */

const { open } = previewBrowser();

describe("Rules", () => {
  it("shows every choice in the last rule's decision menu", async () => {
    for (const width of [390, 1280]) {
      const page = await open("/rules/loaded", width);
      try {
        const triggers = page.locator(".rule-list .ui-select-trigger");
        await triggers.last().click();
        const list = page.locator(".ui-select-content:not([hidden])");
        expect(await clipped(list), `at ${String(width)}`).toEqual([]);
      } finally {
        await page.context().close();
      }
    }
  });
});
