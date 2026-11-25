import { describe, expect, it } from "vitest";
import { endSession, sessionCookieName } from "../../src/web/sessions.ts";
import { shellBrowser } from "./shell-browser.ts";

/**
 * Activity's live stream in a real browser: when the session ends, the
 * stream stops and the page says so, with a link back to sign in.
 */

const shell = shellBrowser();

describe("Activity's live stream in a browser", () => {
  it("says the session ended and links to sign in", async () => {
    const { h, publicUrl, context, page } = await shell.signedIn();
    await page.goto(`${publicUrl.origin}/activity`);
    const note = page.getByText("Signed out. Sign in to see new activity.");
    expect(await note.isVisible()).toBe(false);
    const name = sessionCookieName(publicUrl);
    const cookie = (await context.cookies()).find((c) => c.name === name)?.value ?? "";
    endSession(h.t.db, cookie, h.clock.now);
    await note.waitFor({ timeout: 15_000 });
    expect(await page.getByRole("link", { name: "Sign in" }).getAttribute("href")).toBe(
      "/sign-in?next=%2Factivity",
    );
  });
});
