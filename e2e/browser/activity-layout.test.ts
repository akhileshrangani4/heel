import { describe, expect, it } from "vitest";
import { shellBrowser } from "./shell-browser.ts";

/**
 * Activity in a real browser: nothing wider than a phone, rows with their
 * own padding and the badge at the top, and the Filter and Download panels
 * closing like menus.
 */

const shell = shellBrowser();

const STORIES = [
  "activity/busy",
  "activity/empty",
  "activity/filtered-empty",
  "activity/long",
  "activity/older",
  "activity/member",
];

describe("Activity in a browser", () => {
  it("fits on a 360 and a 390 px phone, light and dark", async () => {
    const origin = await shell.preview();
    const wide: string[] = [];
    for (const width of [360, 390]) {
      for (const theme of ["light", "dark"] as const) {
        const page = await shell.phone(width, theme);
        for (const story of STORIES) {
          await page.goto(`${origin}/${story}?theme=${theme}`);
          const scroll = await page.evaluate<number>("document.documentElement.scrollWidth");
          if (scroll > width) wide.push(`${story} ${theme} at ${width}: ${scroll}px`);
        }
      }
    }
    expect(wide).toEqual([]);
  });

  it("lays rows out with their own padding, badge at the top", async () => {
    const origin = await shell.preview();
    const page = await shell.phone(390);
    await page.goto(`${origin}/activity/busy?theme=light`);
    // Strings, not functions: this file is typed for Node, without the DOM.
    const cells = await page.evaluate<{ padding: string; gap: number }>(`(() => {
      const row = document.querySelector("#activity tr[data-id]");
      const kind = row.querySelector(".act-kind");
      const what = row.querySelector(".act-what");
      return {
        padding: getComputedStyle(kind).padding,
        gap: what.getBoundingClientRect().top - kind.getBoundingClientRect().bottom,
      };
    })()`);
    expect(cells.padding).toBe("0px");
    expect(cells.gap).toBeLessThan(8);
  });

  it("closes the Filter panel on Escape or a click outside, and keeps it open for a click inside", async () => {
    const origin = await shell.preview();
    const page = await shell.phone(360);
    await page.goto(`${origin}/activity/busy?theme=light`);
    const open = () =>
      page.evaluate<string[]>(
        `[...document.querySelectorAll("details.act-filter, details.audit-export")].filter((d) => d.open).map((d) => d.className)`,
      );
    await page.locator(".act-filter > summary").click();
    await page.locator(".act-option").nth(1).click();
    expect(await open()).toEqual(["act-filter"]);
    await page.keyboard.press("Escape");
    expect(await open()).toEqual([]);
    expect(await page.evaluate<string>('document.activeElement.closest("details").className')).toBe(
      "act-filter",
    );
    await page.locator(".audit-export > summary").click();
    await page.mouse.click(5, 5);
    expect(await open()).toEqual([]);
  });

  it("has no filter count badge: the chips already show each filter", async () => {
    const origin = await shell.preview();
    const page = await shell.phone(390);
    await page.goto(`${origin}/activity/long?theme=light`);
    expect(await page.locator(".act-filter > summary").textContent()).toBe("Filter");
  });
});
