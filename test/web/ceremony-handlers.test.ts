import { describe, expect, it } from "vitest";
import { humanPlaneHarness } from "../helpers/human-plane.ts";

/**
 * A passkey button only works if its page also loads the script that
 * registers the button's handler. Without it the button says "Passkey check
 * isn't available on this page yet", as Connect another account and the
 * Agents page's controls did after 2.9.
 */

const PAGES = [
  "approvals",
  "activity",
  "agents",
  "standing",
  "pause",
  "connections",
  "grants",
  "modes",
  "people",
  "rules",
  "devices",
];

describe("passkey buttons", () => {
  it("have their handler on every signed-in page", async () => {
    const h = humanPlaneHarness();
    const admin = await h.signIn(await h.enroll());
    const checked: string[] = [];
    for (const path of PAGES) {
      const response = await h.fetch(`/${path}`, { as: admin });
      if (response.status !== 200) continue;
      const page = await response.text();
      const handlers = new Set(
        [...page.matchAll(/data-heel-handler="([A-Za-z]+)"/g)].map((m) => m[1] ?? ""),
      );
      if (handlers.size === 0) continue;
      checked.push(path);
      for (const name of handlers) {
        expect({ path, name, registered: page.includes(`    ${name}: (`) }).toEqual({
          path,
          name,
          registered: true,
        });
      }
    }
    expect(checked).toEqual(expect.arrayContaining(["connections", "agents", "approvals"]));
  });
});
