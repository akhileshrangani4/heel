import { describe, expect, it } from "vitest";
import { pendingList } from "../../src/web/ui/pending-list.ts";
import {
  APPROVED_ROWS,
  DENIED_ROWS,
  EXPIRED_ROWS,
  NOW,
  PAUSED_ROWS,
  PENDING_ROWS,
} from "../../src/web/ui/preview/fixtures.ts";
import { dom, text } from "../helpers/dom.ts";

const render = (rows: Parameters<typeof pendingList>[0]["load"]) =>
  dom(pendingList({ now: NOW, load: rows }));

describe("PendingList", () => {
  it("links each request to its full page and shows agent, account and rule", () => {
    const doc = render({ ok: true, rows: PENDING_ROWS });
    const hrefs = [...doc.querySelectorAll("tbody a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(PENDING_ROWS.map((r) => `/approvals/${r.id}`));
    expect(text(doc.querySelector("caption"))).toBe("3 requests");
    expect(text(doc)).toContain("prod-merges-ask-admin (org-rules.yaml:8) (org)");
  });

  it("I-56: the list has no decision controls at all; deciding happens on the request page", () => {
    for (const rows of [PENDING_ROWS, APPROVED_ROWS, DENIED_ROWS, EXPIRED_ROWS, PAUSED_ROWS]) {
      const doc = render({ ok: true, rows });
      expect(doc.querySelectorAll("button, form, input")).toHaveLength(0);
    }
  });

  it.each([
    ["pending", PENDING_ROWS, "Pending", "Expires in"],
    ["approved", APPROVED_ROWS, "Approved", "Runs when the agent re-sends"],
    ["denied", DENIED_ROWS, "Denied", "Re-sends return “denied” until"],
    ["expired", EXPIRED_ROWS, "Expired", "Expired"],
    ["paused", PAUSED_ROWS, "Pending", "Paused (agent inbox-bot): approve after resume"],
  ] as const)("spells out the %s state in words", (_s, rows, badge, note) => {
    const page = text(render({ ok: true, rows }));
    expect(page).toContain(badge);
    expect(page).toContain(note);
  });

  it("shows an empty state and a load-error alert", () => {
    expect(text(render({ ok: true, rows: [] }))).toContain("Nothing is waiting for you");
    const failed = render({ ok: false, message: "db down" });
    expect(text(failed.querySelector("[role=alert]"))).toContain("db down");
  });
});
