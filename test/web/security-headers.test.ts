import { describe, expect, it } from "vitest";
import { humanPlaneHarness } from "../helpers/human-plane.ts";

/** Red-team round 3: the human plane sent no framing or referrer protection. */
describe("security headers on the human plane", () => {
  it("are on pages, redirects, errors and the sign-in page", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    for (const response of [
      await h.fetch("/approvals", { as: owner }),
      await h.fetch("/"),
      await h.fetch("/sign-in"),
      await h.fetch("/no-such-page", { as: owner }),
    ]) {
      expect(response.headers.get("x-frame-options")).toBe("DENY");
      expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect(response.headers.get("referrer-policy")).toBe("same-origin");
      // A popup another site opens gets no handle on heel's window.
      expect(response.headers.get("cross-origin-opener-policy")).toBe("same-origin");
    }
  });
});
