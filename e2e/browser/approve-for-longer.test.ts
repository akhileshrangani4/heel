import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { allowLabel, STANDING_DURATIONS } from "../../src/web/ui/approval-request.ts";
import { toHtmlString } from "../../src/web/ui/html.ts";
import { findStory, renderStory } from "../../src/web/ui/preview/stories.ts";

/**
 * The approve button always says what pressing it does (I-56: the passkey is
 * bound to exactly what is shown). The page is the preview story, whose
 * ceremony handler only announces the intent and options it was given, so
 * each click shows exactly what would be signed.
 */

const story = findStory("approval-request", "pending");
if (story === undefined) throw new Error("no pending story");
const PAGE = toHtmlString(renderStory(story, "light"));

/** The one approve button the owner can see, and its words. */
const APPROVE = ".ap-split button[data-heel-ceremony^='approve']:visible";

async function visibleApprove(page: Page): Promise<{ intent: string; label: string }> {
  const shown = page.locator(APPROVE);
  const count = await shown.count();
  if (count !== 1) throw new Error(`${count} approve buttons visible`);
  return {
    intent: (await shown.getAttribute("data-heel-ceremony")) ?? "",
    label: (await shown.innerText()).trim(),
  };
}

/** Press it and read what the ceremony was asked to sign. */
async function press(page: Page): Promise<string> {
  await page.locator(APPROVE).click();
  return (await page.locator("#heel-ceremony-status").textContent()) ?? "";
}

describe("approving for longer", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch();
  });
  afterAll(async () => {
    await browser?.close();
  });

  it("I-56: says Approve once by default, and pressing it approves once", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(PAGE);
    expect(await visibleApprove(page)).toEqual({ intent: "approve-once", label: "Approve once" });
    const said = await press(page);
    expect(said).toContain("approve-once passkey ceremony");
    expect(said).not.toContain("duration");
    await page.close();
  });

  const scopes = ["exact_call", "rule", "run"] as const;
  const combos = scopes.flatMap((scope) =>
    STANDING_DURATIONS.map((d) => [scope, d.value] as const),
  );

  it.each(combos)(
    "I-56: %s for %s: the label names the choice, and the ceremony gets exactly that choice",
    async (scope, duration) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
      await page.setContent(PAGE);
      await page.locator(".ap-split-toggle").click();
      await page.locator(`.ap-menu input[name=scope][value='${scope}']`).check({ force: true });
      await page
        .locator(`.ap-menu input[name=duration][value='${duration}']`)
        .check({ force: true });
      expect(await visibleApprove(page)).toEqual({
        intent: "approve-standing",
        label: allowLabel(scope, duration),
      });
      const said = await press(page);
      expect(said).toContain("approve-standing passkey ceremony");
      expect(said).toContain(JSON.stringify({ scope, duration }));
      await page.close();
    },
  );

  it("goes back to Approve once when the menu closes, so an abandoned choice never stays", async () => {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.setContent(PAGE);
    await page.locator(".ap-split-toggle").click();
    await page.locator(".ap-menu input[name=scope][value=rule]").check({ force: true });
    await page.locator(".ap-menu input[name=duration][value='30d']").check({ force: true });
    expect((await visibleApprove(page)).label).toBe(allowLabel("rule", "30d"));
    await page.locator(".ap-split-toggle").click();
    // The reset runs on the menu's toggle event, which fires just after the click.
    await expect
      .poll(() => visibleApprove(page))
      .toEqual({
        intent: "approve-once",
        label: "Approve once",
      });
    await page.close();
  });
});
