import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { getRequestListener } from "@hono/node-server";
import { type Browser, chromium, type Locator, type Page } from "@playwright/test";
import { afterAll, beforeAll } from "vitest";
import { createPreviewApp } from "../../src/web/ui/preview/app.ts";

/**
 * Shared setup for browser checks over the preview harness's fixture stories:
 * a preview server and Chromium for the test file, a page opener at a given
 * width and theme, and page-side measurements.
 */

export const PHONES = [360, 390] as const;

/**
 * The browser globals the page-side callbacks use. heel's TypeScript has no
 * DOM lib, so each callback casts `globalThis` to this (a cast only: the
 * callbacks run in the page, where these exist).
 */
export interface Box {
  left: number;
  right: number;
  top: number;
  bottom: number;
  width: number;
  height: number;
}
export interface El {
  tagName: string;
  className: string;
  textContent: string | null;
  parentElement: El | null;
  getBoundingClientRect(): Box;
  getClientRects(): { length: number };
  contains(other: El): boolean;
}
export interface Paint {
  fillStyle: string;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Iterable<number> };
}
export interface Win {
  innerWidth: number;
  getComputedStyle(el: El): {
    overflowX: string;
    overflowY: string;
    padding: string;
    backgroundColor: string;
    color: string;
    opacity: string;
  };
  document: {
    documentElement: { scrollWidth: number };
    querySelectorAll(selector: string): Iterable<El>;
    elementFromPoint(x: number, y: number): El | null;
    createElement(tag: "canvas"): { getContext(kind: "2d"): Paint | null };
  };
}

/**
 * Starts the preview server and Chromium for the calling test file, and
 * returns `open`, which loads a story at a width (with touch below 1000px)
 * and theme. Close each page's context when done.
 */
export function previewBrowser(): {
  open(path: string, width: number, theme?: string): Promise<Page>;
} {
  let server: Server;
  let origin: string;
  let browser: Browser;

  beforeAll(async () => {
    server = createServer(getRequestListener(createPreviewApp().fetch));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    async open(path, width, theme = "light") {
      const context = await browser.newContext({
        viewport: { width, height: 760 },
        // Not isMobile: a mobile viewport widens to fit the page, which hides sideways scroll.
        hasTouch: width < 1000,
      });
      const page = await context.newPage();
      await page.goto(`${origin}${path}?theme=${theme}`);
      return page;
    },
  };
}

/** How far the page scrolls sideways: 0 when it fits. */
export function sideways(page: Page): Promise<number> {
  return page.evaluate(() => {
    const w = globalThis as unknown as Win;
    return w.document.documentElement.scrollWidth - w.innerWidth;
  });
}

/** Where `el` is cut off: by the viewport's sides, or by an ancestor that clips its overflow. */
export function clipped(el: Locator): Promise<string[]> {
  return el.evaluate((node) => {
    const w = globalThis as unknown as Win;
    const box = node.getBoundingClientRect();
    const out: string[] = [];
    if (box.left < -1 || box.right > w.innerWidth + 1) out.push("off the side of the screen");
    for (let p = (node as unknown as El).parentElement; p; p = p.parentElement) {
      const style = w.getComputedStyle(p);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const outer = p.getBoundingClientRect();
      if (
        box.bottom > outer.bottom + 1 ||
        box.top < outer.top - 1 ||
        box.right > outer.right + 1 ||
        box.left < outer.left - 1
      )
        out.push(`clipped by ${p.tagName.toLowerCase()}.${p.className}`);
    }
    return out;
  });
}
