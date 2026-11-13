import { describe, expect, it } from "vitest";
import { PALETTES, STYLESHEET } from "../../src/web/ui/theme.ts";

/** WCAG 2.x relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Foreground/background pairs the stylesheet actually draws, with the WCAG AA minimum for each. */
const PAIRS = [
  ["text", "bg", 4.5],
  ["text", "surface", 4.5],
  ["muted", "bg", 4.5],
  ["muted", "surface", 4.5],
  ["accent", "bg", 4.5],
  ["accent-text", "accent", 4.5],
  ["danger", "bg", 4.5],
  ["danger-text", "danger", 4.5],
  ["ok", "bg", 4.5],
  ["warn", "bg", 4.5],
  ["info", "bg", 4.5],
  ["banner-text", "banner-bg", 4.5],
  ["text", "add-bg", 4.5],
  ["text", "remove-bg", 4.5],
  // Non-text UI: the focus ring needs 3:1 against the page (WCAG 1.4.11).
  ["focus", "bg", 3],
] as const;

describe("theme", () => {
  describe.each(Object.entries(PALETTES))("%s palette", (_name, palette) => {
    it.each(PAIRS)("%s on %s meets %d:1", (fg, bg, min) => {
      expect(contrast(palette[fg], palette[bg])).toBeGreaterThanOrEqual(min);
    });
  });

  it("draws a visible focus ring and supports both forced themes and the system setting", () => {
    expect(STYLESHEET).toContain(":focus-visible{outline:3px solid var(--focus)");
    expect(STYLESHEET).toMatch(/\[data-theme="?dark"?\]/);
    expect(STYLESHEET).toMatch(/\[data-theme="?light"?\]/);
    expect(STYLESHEET).toContain("@media (prefers-color-scheme: dark)");
  });

  it("keeps the passkey ceremony message on screen wherever the page is scrolled", () => {
    // The status region sits at the top of <main>; on a long approval page the
    // decision buttons are far below it, so a non-empty message is pinned to the viewport.
    expect(STYLESHEET).toMatch(/#heel-ceremony-status:not\(:empty\)\{[^}]*position:fixed/);
  });

  it("I-57: never clips or ellipsizes text", () => {
    expect(STYLESHEET).not.toMatch(/text-overflow|line-clamp/);
    expect(STYLESHEET).toMatch(/pre\.args,pre\.body\{[^}]*white-space:pre-wrap/);
  });
});
