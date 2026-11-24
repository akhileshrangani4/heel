import { describe, expect, it } from "vitest";
import { LOCAL_TIME_SCRIPT } from "../../src/web/ui/format.ts";
import { toHtmlString } from "../../src/web/ui/html.ts";
import { page, time } from "../../src/web/ui/layout.ts";

/** Times show in the viewer's own zone; UTC is only the no-script fallback. */
describe("local times", () => {
  it("renders the instant with a UTC fallback, marked for the local-time script", () => {
    const at = new Date("2026-11-13T14:05:00.000Z");
    expect(toHtmlString(time(at))).toBe(
      '<time datetime="2026-11-13T14:05:00.000Z" data-heel-local>2026-11-13 14:05 UTC</time>',
    );
  });

  it("every page carries the script, which only rewrites text", () => {
    const doc = toHtmlString(page({ title: "t", viewer: null, body: time(new Date(0)) }));
    expect(doc).toContain(LOCAL_TIME_SCRIPT.trim());
    expect(LOCAL_TIME_SCRIPT).toContain("Intl.DateTimeFormat");
    expect(LOCAL_TIME_SCRIPT).not.toMatch(/fetch\(|XMLHttpRequest|innerHTML/);
  });
});
