import { describe, expect, it } from "vitest";
import { endSession, sessionCookieName } from "../../src/web/sessions.ts";
import { shellBrowser } from "./shell-browser.ts";

/**
 * Error pages in a real browser: they fit a phone, and each has a way back
 * to Home (an app installed to the Home Screen has no back button).
 */

const shell = shellBrowser();

const STORIES = ["error/not-found", "error/stale-form", "error/server-error", "enroll/invalid"];

describe("error pages in a browser", () => {
  it("fit a 360 and a 390 px phone, light and dark, with Go to Home", async () => {
    const origin = await shell.preview();
    const wide: string[] = [];
    const noWayHome: string[] = [];
    for (const width of [360, 390]) {
      for (const theme of ["light", "dark"] as const) {
        const page = await shell.phone(width, theme);
        for (const story of STORIES) {
          await page.goto(`${origin}/${story}?theme=${theme}`);
          const scroll = await page.evaluate<number>("document.documentElement.scrollWidth");
          if (scroll > width) wide.push(`${story} ${theme} at ${width}: ${scroll}px`);
          const home = page.getByRole("link", { name: "Go to Home" });
          if ((await home.getAttribute("href")) !== "/") noWayHome.push(story);
        }
      }
    }
    expect(wide).toEqual([]);
    expect(noWayHome).toEqual([]);
  });

  it("sends Sign out after the session ended to sign in, with a notice, not raw JSON", async () => {
    const { h, publicUrl, context, page } = await shell.signedIn();
    const name = sessionCookieName(publicUrl);
    const cookie = (await context.cookies()).find((c) => c.name === name)?.value ?? "";
    endSession(h.t.db, cookie, h.clock.now);
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await page.waitForURL(/\/sign-in\?next=%2F&expired$/);
    await page.getByText("Your session ended. Sign in again to continue.").waitFor();
  });
});
