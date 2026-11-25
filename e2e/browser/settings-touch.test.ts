import type { Locator } from "@playwright/test";
import { describe, expect, it } from "vitest";
import { type El, previewBrowser, type Win } from "./preview-browser.ts";

/**
 * The settings pages' small controls take taps from a 44px area on a touch
 * screen, and a revoked agent's row keeps readable contrast.
 */

const { open } = previewBrowser();

describe("tap targets on a touch screen", () => {
  const SMALL: readonly [string, string][] = [
    ["/pause-control/paused", ".ui-switch[role=switch]"],
    ["/pause-control/pending", ".pause-everything .btn"],
    ["/modes/mixed", "button.seg-item"],
    ["/modes/mixed", ".set-fold > summary"],
    ["/people/admin", ".set-menu > summary"],
    ["/agents/busy", ".row-manage > summary"],
    ["/grants/busy", ".how-fold > summary"],
    ["/grants/busy", ".cell-actions .btn"],
    ["/rules/loaded", ".rule-remove"],
    ["/rule-history/busy", ".fold > summary"],
    ["/devices/several", ".settings-row-foot .btn"],
  ];

  it.each(SMALL)("%s: %s takes a tap 22px from its centre", async (path, selector) => {
    const page = await open(path, 390);
    try {
      const control = page.locator(selector).first();
      await control.scrollIntoViewIfNeeded();
      const misses = await control.evaluate((target) => {
        const w = globalThis as unknown as Win;
        const el = target as unknown as El;
        const box = el.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        return [
          [x, y - 21],
          [x, y + 21],
          [box.left + Math.min(box.width, 44) / 2 - 21, y],
        ]
          .filter(([px, py]) => {
            const hit = w.document.elementFromPoint(px ?? 0, py ?? 0);
            return !(hit !== null && (hit === el || el.contains(hit)));
          })
          .map(([px, py]) => `${String(Math.round(px ?? 0))},${String(Math.round(py ?? 0))}`);
      });
      expect(misses).toEqual([]);
    } finally {
      await page.context().close();
    }
  });
});

/** The contrast ratio of `el`'s text against the first opaque background behind it, after opacity. */
function contrast(el: Locator): Promise<number> {
  return el.evaluate((target) => {
    const w = globalThis as unknown as Win;
    const node = target as unknown as El;
    const ctx = w.document.createElement("canvas").getContext("2d");
    if (ctx === null) throw new Error("no canvas");
    const rgba = (value: string): number[] => {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      return [...ctx.getImageData(0, 0, 1, 1).data];
    };
    let bg = [255, 255, 255];
    for (let p: El | null = node; p; p = p.parentElement) {
      const c = rgba(w.getComputedStyle(p).backgroundColor);
      if ((c[3] ?? 0) === 255) {
        bg = c.slice(0, 3);
        break;
      }
    }
    let alpha = 1;
    for (let p: El | null = node; p; p = p.parentElement) {
      alpha *= Number(w.getComputedStyle(p).opacity);
    }
    const fg = rgba(w.getComputedStyle(node).color);
    alpha *= (fg[3] ?? 255) / 255;
    const mixed = bg.map((b, i) => (fg[i] ?? 0) * alpha + b * (1 - alpha));
    const lum = (c: number[]) => {
      const [r, g, b] = c.map((v) => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const [hi, lo] = [lum(mixed), lum(bg)].sort((a, b) => b - a);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  });
}

describe("Agents", () => {
  it("keeps a revoked agent's details readable in both themes", async () => {
    for (const theme of ["light", "dark"]) {
      const page = await open("/agents/busy", 1280, theme);
      try {
        const subs = page.locator("tr[data-revoked] .cell-sub, tr[data-revoked] .muted");
        expect(await subs.count()).toBeGreaterThan(0);
        for (let i = 0; i < (await subs.count()); i++) {
          expect(await contrast(subs.nth(i)), `${theme} ${String(i)}`).toBeGreaterThanOrEqual(4.5);
        }
      } finally {
        await page.context().close();
      }
    }
  });
});
