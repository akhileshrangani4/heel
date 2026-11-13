import { describe, expect, it } from "vitest";
import {
  type ApprovalRequestProps,
  type ApprovalRequestView,
  approvalRequest,
  STANDING_DURATIONS,
} from "../../src/web/ui/approval-request.ts";
import { formatArguments } from "../../src/web/ui/format.ts";
import {
  AGENT_PAUSE,
  APPROVED_REQUEST,
  DENIED_REQUEST,
  EXECUTED_REQUEST,
  EXPIRED_REQUEST,
  LONG_BODY,
  MANY_CC,
  NOW,
  ORG_REQUEST,
  PENDING_REQUEST,
} from "../../src/web/ui/preview/fixtures.ts";
import { renderStory, STORIES } from "../../src/web/ui/preview/stories.ts";
import { dom, text, type UiDocument, type UiElement } from "../helpers/dom.ts";

const DECIDE = { handler: "decideApproval" } as const;

function render(
  request: ApprovalRequestView,
  over: Partial<ApprovalRequestProps> = {},
): UiDocument {
  return dom(
    approvalRequest({
      now: NOW,
      load: { ok: true, request },
      pause: null,
      onDecide: DECIDE,
      ...over,
    }),
  );
}

const button = (doc: UiDocument, intent: string): UiElement | null =>
  doc.querySelector(`button[data-heel-ceremony="${intent}"]`);

describe("ApprovalRequest", () => {
  it("shows agent, run, account, action, rule, counts and expiry", () => {
    const page = text(render(PENDING_REQUEST));
    for (const fact of [
      "inbox-bot",
      "run-2026-11-13.r42",
      "gmail-work",
      "email.send",
      "client-sends-ask (rules/alice.yaml:14)",
      "3 items this run, including this call (the rule asks over 5)",
      "7 items this hour",
      "1 item in this call",
    ]) {
      expect(page).toContain(fact);
    }
    expect(
      render(PENDING_REQUEST).querySelector(
        `time[datetime="${PENDING_REQUEST.expiresAt.toISOString()}"]`,
      ),
    ).not.toBeNull();
  });

  describe("I-57: full arguments, untruncated", () => {
    it("I-57: the arguments block is exactly the full formatted arguments", () => {
      const doc = render(PENDING_REQUEST);
      const args = doc.querySelector("pre.args");
      expect(args?.textContent).toBe(formatArguments(PENDING_REQUEST.args));
      expect(JSON.parse(args?.textContent ?? "null")).toEqual(PENDING_REQUEST.args);
    });

    it("I-57: a long body and every one of 40 recipients appear in full", () => {
      const doc = render(PENDING_REQUEST);
      const args = doc.querySelector("pre.args")?.textContent ?? "";
      const body = doc.querySelector("pre.body")?.textContent ?? "";
      expect(body).toBe(LONG_BODY);
      expect(args).toContain("END-OF-BODY-MARKER");
      for (const address of MANY_CC) {
        expect(args).toContain(`"${address}"`);
        expect(text(doc)).toContain(address);
      }
      expect(args).not.toMatch(/…|\.\.\.$/m);
    });

    it("I-57: a 200 KB argument value is rendered whole", () => {
      const huge = `${"x".repeat(200_000)}TAIL`;
      const doc = render({ ...PENDING_REQUEST, args: { blob: huge }, email: null });
      expect(JSON.parse(doc.querySelector("pre.args")?.textContent ?? "null")).toEqual({
        blob: huge,
      });
    });

    it("I-57: markup in arguments and bodies is shown as text, never rendered", () => {
      const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
      const email = PENDING_REQUEST.email;
      if (!email) throw new Error("PENDING_REQUEST fixture must carry an email preview");
      const doc = render({
        ...PENDING_REQUEST,
        args: { body: hostile },
        email: { ...email, body: hostile, bodyFormat: "html" },
      });
      expect(doc.querySelector("main img, main script, body img")).toBeNull();
      expect(doc.querySelector("pre.body")?.textContent).toBe(hostile);
      expect(text(doc)).toContain("HTML source, not rendered");
    });
  });

  describe("I-56: decisions only start the passkey ceremony", () => {
    const decisionStates = STORIES.filter((s) => s.component === "approval-request");

    it.each(decisionStates.map((s) => [s.state, s] as const))(
      "I-56: %s has no control that decides without a ceremony",
      (_state, story) => {
        const doc = dom(renderStory(story, "light"));
        const main = doc.querySelector("main");
        if (!main) throw new Error("no main");
        // No form, submit control or link on the page can carry a decision.
        for (const form of main.querySelectorAll("form")) {
          expect(form.getAttribute("action") ?? "").not.toMatch(/approv|decid|deny|resume/i);
        }
        expect(
          main.querySelectorAll("input[type=submit], button[type=submit], button:not([type])"),
        ).toHaveLength(0);
        for (const a of main.querySelectorAll("a[href]")) {
          expect(a.getAttribute("href") ?? "").not.toMatch(/approv|decid|deny/i);
        }
        // Every decision button is a plain button that names its ceremony handler.
        for (const b of main.querySelectorAll("button")) {
          expect(b.getAttribute("type")).toBe("button");
          expect(b.closest("form")).toBeNull();
          expect(b.getAttribute("data-heel-ceremony")).toMatch(
            /^(approve-once|approve-standing|deny)$/,
          );
          expect(b.getAttribute("data-heel-handler")).toBe("decide");
        }
      },
    );

    it("I-56: buttons call the handler named by the onDecide prop, bound to id and call hash", () => {
      const doc = render(PENDING_REQUEST);
      const buttons = [...doc.querySelectorAll("button")];
      expect(buttons.map((b) => b.getAttribute("data-heel-ceremony"))).toEqual([
        "approve-once",
        "approve-standing",
        "deny",
      ]);
      for (const b of buttons) {
        expect(b.getAttribute("data-heel-handler")).toBe(DECIDE.handler);
        expect(b.getAttribute("data-approval-id")).toBe(PENDING_REQUEST.id);
        expect(b.getAttribute("data-call-hash")).toBe(PENDING_REQUEST.callHash);
        const help = doc.getElementById(b.getAttribute("aria-describedby") ?? "");
        expect(text(help)).toMatch(/passkey/i);
      }
    });

    it("I-56: approve-as-standing reads its options from the standing fieldset", () => {
      const doc = render(PENDING_REQUEST);
      const fieldsetId = button(doc, "approve-standing")?.getAttribute("data-heel-options") ?? "";
      expect(doc.getElementById(fieldsetId)?.tagName.toLowerCase()).toBe("fieldset");
    });
  });

  it("offers 1 h, 1 day, 7 days and 30 days, exact call or rule match, capped at 90 days", () => {
    const doc = render(PENDING_REQUEST);
    const options = [...doc.querySelectorAll("fieldset select option")].map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toEqual(STANDING_DURATIONS.map((d) => d.value));
    expect(options).toEqual(["1h", "1d", "7d", "30d"]);
    const scopes = [...doc.querySelectorAll("fieldset input[type=radio]")].map((r) =>
      r.getAttribute("value"),
    );
    expect(scopes).toEqual(["exact_call", "rule"]);
    expect(doc.querySelector("fieldset input[value=exact_call]")?.hasAttribute("checked")).toBe(
      true,
    );
    expect(text(doc.querySelector("fieldset"))).toContain("at most 90 days");
  });

  it("org asks are approve-once only, with no standing option (Q-A7)", () => {
    const doc = render(ORG_REQUEST);
    expect(button(doc, "approve-once")).not.toBeNull();
    expect(button(doc, "approve-standing")).toBeNull();
    expect(doc.querySelector("fieldset")).toBeNull();
    expect(text(doc)).toContain("Org asks never stand");
  });

  it("I-61: while paused, approving is disabled and deny stays available", () => {
    const doc = render(PENDING_REQUEST, { pause: AGENT_PAUSE });
    expect(button(doc, "approve-once")?.hasAttribute("disabled")).toBe(true);
    expect(button(doc, "approve-standing")?.hasAttribute("disabled")).toBe(true);
    expect(doc.querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
    expect(button(doc, "deny")?.hasAttribute("disabled")).toBe(false);
    expect(text(doc)).toContain("Approving is unavailable while agent inbox-bot is paused");
  });

  it("I-55: an expired request shows every decision control disabled", () => {
    const doc = render(EXPIRED_REQUEST);
    for (const intent of ["approve-once", "approve-standing", "deny"]) {
      expect(button(doc, intent)?.hasAttribute("disabled"), intent).toBe(true);
    }
    expect(text(doc)).toContain("can't be approved or denied");
  });

  it.each([
    ["approved", APPROVED_REQUEST, "runs once when the agent re-sends the identical call"],
    ["denied", DENIED_REQUEST, "Re-sends of this call return “denied”"],
    ["executed", EXECUTED_REQUEST, "Ran once"],
  ] as const)(
    "a decided (%s) request explains itself and has no decision controls",
    (_s, request, note) => {
      const doc = render(request);
      expect(doc.querySelectorAll("button")).toHaveLength(0);
      expect(text(doc)).toContain(note);
    },
  );

  it("a load failure is an alert that says nothing was decided", () => {
    const doc = dom(
      approvalRequest({
        now: NOW,
        load: { ok: false, message: "db down" },
        pause: null,
        onDecide: DECIDE,
      }),
    );
    expect(text(doc.querySelector("[role=alert]"))).toContain("db down");
    expect(text(doc)).toContain("Nothing was decided.");
    expect(doc.querySelectorAll("button")).toHaveLength(0);
  });
});
