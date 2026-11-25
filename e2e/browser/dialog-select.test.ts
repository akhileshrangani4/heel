import { describe, expect, it } from "vitest";
import { clipped, previewBrowser } from "./preview-browser.ts";

/** A select near the bottom of a dialog opens its menu where the dialog doesn't cut it off. */

const { open } = previewBrowser();

describe("menus inside a dialog", () => {
  it("opens a dialog's last menu where the dialog doesn't cut it off", async () => {
    for (const [path, dialog] of [
      ["/grants/busy", "grant-dialog"],
      ["/agents/busy", "add-agent-dialog"],
    ] as const) {
      for (const width of [390, 1280]) {
        const page = await open(path, width);
        try {
          await page.locator(`button[aria-controls="${dialog}"]`).click();
          await page.locator(`#${dialog} .ui-select-trigger`).last().click();
          const list = page.locator(".ui-select-content:not([hidden])");
          expect(await clipped(list), `${path} at ${String(width)}`).toEqual([]);
        } finally {
          await page.context().close();
        }
      }
    }
  });
});
