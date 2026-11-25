import { describe, expect, it } from "vitest";
import { shellBrowser } from "./shell-browser.ts";

/**
 * The passkey status message and dialogs on a phone: the status sits above
 * the tab bar, not under it, and a dialog fits the visible screen while the
 * page behind it holds still.
 */

const shell = shellBrowser();

describe("the passkey status and dialogs in a browser", () => {
  it("shows the passkey status above the phone tab bar", async () => {
    const origin = await shell.preview();
    const page = await shell.phone(390);
    await page.goto(`${origin}/activity/busy?theme=light`);
    // Strings, not functions: this file is typed for Node, without the DOM.
    const box = await page.evaluate<{ status: number; nav: number }>(`(() => {
      const status = document.getElementById("heel-ceremony-status");
      status.textContent = "Waiting for your passkey…";
      return {
        status: status.getBoundingClientRect().bottom,
        nav: document.querySelector(".site nav").getBoundingClientRect().top,
      };
    })()`);
    expect(box.status).toBeLessThanOrEqual(box.nav);
  });

  it("keeps a dialog inside a landscape phone and the page still behind it", async () => {
    const origin = await shell.preview();
    const context = await shell.browser().newContext({
      viewport: { width: 844, height: 390 },
      hasTouch: true,
      isMobile: true,
    });
    const page = await context.newPage();
    await page.goto(`${origin}/agents/busy?theme=light`);
    await page.locator("button[aria-controls=add-agent-dialog]").click();
    const open = await page.evaluate<{ bottom: number; overflow: string }>(`({
      bottom: document.querySelector("dialog[open]").getBoundingClientRect().bottom,
      overflow: getComputedStyle(document.documentElement).overflow,
    })`);
    expect(open.bottom).toBeLessThanOrEqual(390);
    expect(open.overflow).toBe("hidden");
    await page.keyboard.press("Escape");
    expect(await page.evaluate<string>("getComputedStyle(document.documentElement).overflow")).toBe(
      "visible",
    );
    await context.close();
  });
});
