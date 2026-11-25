import { type Browser, chromium, type Page } from "@playwright/test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvalRequest } from "../../src/web/ui/approval-request.ts";
import { clientScript } from "../../src/web/ui/client.ts";
import { toHtmlString } from "../../src/web/ui/html.ts";
import { page as layout } from "../../src/web/ui/layout.ts";
import { NOW, PENDING_REQUEST } from "../../src/web/ui/preview/fixtures.ts";

/**
 * A passkey button keeps its size while the passkey prompt is open: the
 * approval page's real client script, against stubbed challenge routes and
 * a fake `navigator.credentials` that hangs, refuses, or answers. The bar
 * never grows and nothing in it leaves the screen.
 */

const ORIGIN = "http://heel.test";
const HTML = toHtmlString(
  layout({
    title: "Approval request",
    viewer: { name: "alice", role: "member", csrfToken: "csrf" },
    current: "approvals",
    body: approvalRequest({
      now: NOW,
      load: { ok: true, request: PENDING_REQUEST },
      pause: null,
      onDecide: { handler: "decide" },
    }),
    script: clientScript("csrf"),
  }),
);

/** `hang` never resolves; `refuse` is the person cancelling; `answer` signs. */
type Mode = "hang" | "refuse" | "answer";

function fakeCredentials(mode: Mode) {
  const bytes = () => new Uint8Array([1, 2, 3]).buffer;
  const get = () => {
    if (mode === "hang") return new Promise(() => {});
    if (mode === "refuse") return Promise.reject(new DOMException("cancelled", "NotAllowedError"));
    return Promise.resolve({
      id: "AQID",
      rawId: bytes(),
      type: "public-key",
      response: { clientDataJSON: bytes(), authenticatorData: bytes(), signature: bytes() },
      getClientExtensionResults: () => ({}),
    });
  };
  Object.defineProperty(navigator, "credentials", { value: { get, create: get } });
}

let browser: Browser;
beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});

async function open(mode: Mode, width: number, height: number): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript(fakeCredentials, mode);
  await page.route(`${ORIGIN}/**`, (route) => {
    const url = route.request().url();
    if (url.endsWith("/challenge")) {
      return route.fulfill({
        json: {
          ok: true,
          challengeId: "chl",
          options: { challenge: "AAAA", allowCredentials: [] },
        },
      });
    }
    if (url.endsWith("/decide")) return route.fulfill({ json: { ok: true, message: "Approved." } });
    return route.fulfill({ contentType: "text/html", body: HTML });
  });
  await page.goto(`${ORIGIN}/approvals/${PENDING_REQUEST.id}`);
  return page;
}

interface Sizes {
  barHeight: number;
  buttonWidth: number;
  buttonHeight: number;
  /** Elements of the bar that reach past the screen's edges. */
  past: number;
  scrollWidth: number;
  innerWidth: number;
}

/** Runs in the page (as source: the e2e build has no DOM types). */
const MEASURE = `(() => {
  const bar = document.querySelector(".ap-bar").getBoundingClientRect();
  const button = document.querySelector('button[data-heel-ceremony="approve-once"]').getBoundingClientRect();
  const past = [...document.querySelectorAll(".ap-bar, .ap-bar *")].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && (r.right > innerWidth + 0.5 || r.left < -0.5 || r.bottom > innerHeight + 0.5);
  }).length;
  return {
    barHeight: bar.height,
    buttonWidth: button.width,
    buttonHeight: button.height,
    past,
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth,
  };
})()`;
const measure = (page: Page): Promise<Sizes> => page.evaluate(MEASURE);

describe("passkey buttons while the passkey prompt is open", () => {
  for (const [width, height] of [
    [360, 780],
    [390, 844],
    [390, 400],
    [768, 1024],
    [1280, 800],
  ] as const) {
    it(`keep their size and stay on screen at ${width}x${height}`, async () => {
      const page = await open("hang", width, height);
      const idle = await measure(page);
      await page.getByRole("button", { name: "Approve once" }).click();
      await page.locator('[data-heel-state="waiting"]').waitFor();
      const waiting = await measure(page);
      expect(waiting.buttonWidth).toBeCloseTo(idle.buttonWidth, 0);
      expect(waiting.buttonHeight).toBeCloseTo(idle.buttonHeight, 0);
      expect(waiting.barHeight).toBeCloseTo(idle.barHeight, 0);
      expect(waiting.past).toBe(0);
      expect(waiting.scrollWidth).toBeLessThanOrEqual(waiting.innerWidth);
      await page.close();
    });
  }

  it("go back to idle after a cancel or an error, so the owner can try again", async () => {
    const page = await open("refuse", 390, 844);
    const idle = await measure(page);
    await page.getByRole("button", { name: "Approve once" }).click();
    const button = page.locator('button[data-heel-ceremony="approve-once"]');
    await page.locator('[data-heel-state="cancelled"]').waitFor();
    expect(await button.isEnabled()).toBe(true);
    expect((await measure(page)).buttonWidth).toBeCloseTo(idle.buttonWidth, 0);
    await page.close();
  });

  it("show success in the same box once the passkey answers", async () => {
    const page = await open("answer", 390, 844);
    const idle = await measure(page);
    await page.getByRole("button", { name: "Approve once" }).click();
    await page.locator('[data-heel-state="success"]').waitFor();
    expect((await measure(page)).buttonWidth).toBeCloseTo(idle.buttonWidth, 0);
    await page.close();
  });
});
