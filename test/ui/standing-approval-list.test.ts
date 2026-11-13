import { describe, expect, it } from "vitest";
import {
  ACTIVE_STANDING,
  EXPIRED_STANDING,
  NOW,
  PAUSED_STANDING,
  REVOKED_STANDING,
} from "../../src/web/ui/preview/fixtures.ts";
import { standingApprovalList } from "../../src/web/ui/standing-approval-list.ts";
import { dom, text } from "../helpers/dom.ts";

const FORM = { action: "/standing/revoke", csrfToken: "tok-9" } as const;
const render = (load: Parameters<typeof standingApprovalList>[0]["load"]) =>
  dom(standingApprovalList({ now: NOW, load, revokeForm: FORM }));

describe("StandingApprovalList", () => {
  it("offers revoke on each active row as a CSRF form with a distinct accessible name", () => {
    const doc = render({ ok: true, rows: ACTIVE_STANDING });
    const forms = [...doc.querySelectorAll("form")];
    expect(forms).toHaveLength(ACTIVE_STANDING.length);
    expect(forms.map((f) => f.querySelector("input[name=id]")?.getAttribute("value"))).toEqual(
      ACTIVE_STANDING.map((r) => r.id),
    );
    for (const f of forms) {
      expect(f.getAttribute("action")).toBe("/standing/revoke");
      expect(f.querySelector("input[name=csrf]")?.getAttribute("value")).toBe("tok-9");
    }
    const names = forms.map((f) => f.querySelector("button")?.getAttribute("aria-label"));
    expect(new Set(names).size).toBe(names.length);
  });

  it("shows scope, rule and expiry", () => {
    const page = text(render({ ok: true, rows: ACTIVE_STANDING }));
    expect(page).toContain("Everything the rule asks about");
    expect(page).toContain("This exact call (email.label)");
    expect(page).toContain("client-sends-ask (rules/alice.yaml:14)");
    expect(page).toContain("Ends");
  });

  it.each([
    ["revoked", REVOKED_STANDING, "Revoked by alice"],
    ["expired and lapsed", EXPIRED_STANDING, "Lapsed: rule changed"],
  ] as const)("%s rows explain themselves and cannot be revoked again", (_s, rows, words) => {
    const doc = render({ ok: true, rows });
    expect(doc.querySelectorAll("form")).toHaveLength(0);
    expect(text(doc)).toContain(words);
  });

  it("marks active rows under a pause", () => {
    expect(text(render({ ok: true, rows: PAUSED_STANDING }))).toContain(
      "Paused: calls in scope return “paused” anyway",
    );
  });

  it("shows an empty state and a load-error alert", () => {
    expect(text(render({ ok: true, rows: [] }))).toContain("No standing approvals.");
    expect(text(render({ ok: false, message: "db down" }).querySelector("[role=alert]"))).toContain(
      "db down",
    );
  });
});
