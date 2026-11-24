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
  it("makes each whole row the link to its full page, and leaves rule and id to that page", () => {
    const doc = render({ ok: true, rows: PENDING_ROWS });
    const hrefs = [...doc.querySelectorAll("a.req-row")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(PENDING_ROWS.map((r) => `/approvals/${r.id}`));
    // One link per row: the title and "Review" sit inside it, never as links of their own.
    expect(doc.querySelectorAll("a")).toHaveLength(PENDING_ROWS.length);
    // Each section heading carries its count; there is no separate count line.
    expect(doc.querySelector(".req-count")).toBeNull();
    expect(text(doc)).not.toContain("org-rules.yaml:8");
    expect(text(doc)).not.toContain(PENDING_ROWS[0]?.id ?? "-");
  });

  it("groups requests into what needs you, what was decided, and what expired", () => {
    const doc = render({ ok: true, rows: [...PENDING_ROWS, ...APPROVED_ROWS, ...EXPIRED_ROWS] });
    const titles = [...doc.querySelectorAll(".req-section-title")].map((h) => text(h));
    expect(titles).toEqual([
      `Needs you ${PENDING_ROWS.length}`,
      `Decided in the last day ${APPROVED_ROWS.length}`,
      `Expired ${EXPIRED_ROWS.length}`,
    ]);
    // Waiting rows carry no status badge: the section heading already says it.
    expect(doc.querySelectorAll("section:first-of-type .badge")).toHaveLength(0);
    expect(doc.querySelector(".req .req-icon")?.getAttribute("data-kind")).toBe("mail");
  });

  it("says who, what and when: heel's sentence and how long ago, leaving the client and reason to the request page", () => {
    const [first] = PENDING_ROWS;
    if (first === undefined) throw new Error("no fixture");
    const doc = render({
      ok: true,
      rows: [{ ...first, reason: "Sending Bob the renewal numbers." }],
    });
    expect(text(doc.querySelector(".req-title"))).toBe(
      "inbox-bot wants to send an email from gmail-work to bob@vendor.com",
    );
    expect(text(doc.querySelector(".ap-meta"))).toBe("12m");
    expect(text(doc)).not.toContain("via Claude Code");
    expect(doc.querySelector(".req-reason")).toBeNull();
  });

  it("shows a waiting request's expiry only when it is close", () => {
    const doc = render({ ok: true, rows: PENDING_ROWS });
    const notes = [...doc.querySelectorAll(".req-soon")].map((n) => text(n));
    // Only the merge, 8 minutes from expiry; the others have most of a day left.
    expect(notes).toEqual(["Expires in 8m"]);
  });

  it("I-56: the list has no decision controls at all; deciding happens on the request page", () => {
    for (const rows of [PENDING_ROWS, APPROVED_ROWS, DENIED_ROWS, EXPIRED_ROWS, PAUSED_ROWS]) {
      const doc = render({ ok: true, rows });
      expect(doc.querySelectorAll("button, form, input")).toHaveLength(0);
    }
  });

  it.each([
    ["pending", PENDING_ROWS, "Needs you", "Expires in"],
    ["approved", APPROVED_ROWS, "Approved", "Runs when the agent sends it again"],
    ["denied", DENIED_ROWS, "Denied", "Re-sends return “denied” until"],
    ["expired", EXPIRED_ROWS, "Expired", "Expired"],
    ["paused", PAUSED_ROWS, "Needs you", "Paused (agent inbox-bot): approve after resume"],
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
