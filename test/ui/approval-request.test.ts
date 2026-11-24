import { describe, expect, it } from "vitest";
import {
  type ApprovalRequestProps,
  type ApprovalRequestView,
  approvalRequest,
  biggestRisk,
  STANDING_DURATIONS,
} from "../../src/web/ui/approval-request.ts";
import { formatArguments } from "../../src/web/ui/format.ts";
import {
  AGENT_PAUSE,
  APPROVED_REQUEST,
  DENIED_REQUEST,
  EXECUTED_REQUEST,
  EXPIRED_REQUEST,
  GENERIC_REQUEST,
  HINTED_REQUEST,
  HINTS_UNAVAILABLE_REQUEST,
  HTTP_REQUEST,
  LONG_BODY,
  MANY_CC,
  MERGE_REQUEST,
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

/** The email body as the page holds it: the first lines plus the folded rest, rejoined. */
const bodyText = (doc: UiDocument) =>
  [...doc.querySelectorAll(".ap-mail pre.body")].map((p) => p.textContent ?? "").join("\n");

describe("ApprovalRequest", () => {
  it("shows approval adapters' hints as advice, and says when they're unavailable", () => {
    const hinted = render(HINTED_REQUEST);
    const section = text(hinted.querySelector("section[aria-labelledby^='hints-']"));
    expect(section).toContain("Asks someone for money, a payment or account access.");
    expect(section).toContain("It can't approve or deny anything: you decide.");
    expect(text(render(HINTS_UNAVAILABLE_REQUEST).body)).toContain(
      "Hints from jev are unavailable for this request.",
    );
    expect(render(PENDING_REQUEST).querySelector("section[aria-labelledby^='hints-']")).toBeNull();
    expect(
      text(
        render({ ...PENDING_REQUEST, hints: [{ adapter: "jev", result: { status: "pending" } }] })
          .body,
      ),
    ).toContain("Hints from jev are on the way.");
  });

  it("quotes the agent's reason as its own words, as text, and shows nothing without one", () => {
    const reason = text(render(PENDING_REQUEST).querySelector("figure.reason"));
    expect(reason).toContain("inbox-bot says");
    expect(reason).toContain("Sending Bob the Q4 renewal schedule");
    const marked = render({ ...PENDING_REQUEST, reason: "<b>trust me</b>" });
    expect(marked.querySelector("figure.reason b")).toBeNull();
    expect(text(marked.querySelector("figure.reason blockquote"))).toBe("<b>trust me</b>");
    expect(render({ ...PENDING_REQUEST, reason: null }).querySelector("figure.reason")).toBeNull();
  });

  it("shows the script a code-mode call came from, as the agent's code, as text (C3)", () => {
    const doc = render({
      ...PENDING_REQUEST,
      script: {
        code: 'import gmail_work\nmsgs = gmail_work.search(query="invoices")\n<script>alert(1)</script>',
        truncated: false,
        before: [{ account: "gmail-work", tool: "search", decision: "allow" }],
      },
    });
    const section = doc.querySelector("section.script");
    if (section === null) throw new Error("no script section");
    expect(text(section)).toContain("From a script");
    expect(text(section)).toContain("search on gmail-work (allow)");
    expect(text(section)).toContain("heel didn't check what it says");
    expect(text(section)).toContain("<script>alert(1)</script>");
    expect(section.querySelector("script")).toBeNull();

    const plain = render(PENDING_REQUEST);
    expect(plain.querySelector("section.script")).toBeNull();
  });

  it("leads with heel's own sentence, built from the call, above the agent's words", () => {
    const doc = render(PENDING_REQUEST);
    expect(text(doc.querySelector("h1"))).toBe(
      "inbox-bot wants to send an email from gmail-work to bob@vendor.com and 40 others at vendor.com",
    );
    // The agent's reason can't change the sentence.
    const lying = render({ ...PENDING_REQUEST, reason: "Replying only to Bob" });
    expect(text(lying.querySelector("h1"))).toContain("40 others");
    expect(text(render(MERGE_REQUEST).querySelector("h1"))).toBe(
      "release-bot wants to merge pull request #1234 on acme/web into main",
    );
    expect(text(render(GENERIC_REQUEST).querySelector("h1"))).toBe(
      "billing-bot wants to refund a Stripe payment on stripe",
    );
  });

  it("names every recipient domain and marks outsiders; one odd address isn't folded away", () => {
    const email = PENDING_REQUEST.email;
    if (!email) throw new Error("PENDING_REQUEST fixture must carry an email preview");
    const doc = render({
      ...PENDING_REQUEST,
      email: { ...email, cc: [...MANY_CC, "eve@elsewhere.example"] },
    });
    const card = text(doc.querySelector("section[aria-labelledby^='email-']"));
    expect(card).toContain("40 people at vendor.com");
    expect(card).toContain("eve@elsewhere.example");
    const chip = [...doc.querySelectorAll(".ap-chip")].find(
      (c) => text(c) === "eve@elsewhere.example",
    );
    expect(chip?.closest("details")).toBeNull();
    expect(chip?.getAttribute("class")).toContain("is-outside");
  });

  it("opens and closes sections as the person last left them for this kind of request", () => {
    const fresh = render(PENDING_REQUEST);
    const state = (doc: UiDocument, section: string) =>
      doc.querySelector(`details[data-heel-fold="${section}"]`)?.hasAttribute("open");
    expect(fresh.querySelector("article")?.getAttribute("data-heel-fold-kind")).toBe("email.send");
    // A long body shows its first lines; "Show all" is closed until opened.
    expect(state(fresh, "body")).toBe(false);
    expect(state(fresh, "details")).toBe(false);
    expect(state(fresh, "args")).toBe(false);
    expect(state(fresh, "cc:vendor.com")).toBe(false);

    const remembered = render(PENDING_REQUEST, {
      folds: new Map([
        ["body", true],
        ["args", true],
        ["cc:vendor.com", true],
      ]),
    });
    expect(state(remembered, "body")).toBe(true);
    expect(state(remembered, "args")).toBe(true);
    expect(state(remembered, "cc:vendor.com")).toBe(true);
    // Folded or not, everything is still on the page (I-57).
    expect(bodyText(remembered)).toBe(LONG_BODY);
    expect(bodyText(fresh)).toBe(LONG_BODY);
  });

  it("leads with a breadcrumb back to the list, with the status at the top of the side panel", () => {
    const doc = render(PENDING_REQUEST);
    const crumbs = doc.querySelector("nav.ap-crumbs");
    expect(crumbs?.querySelector("a")?.getAttribute("href")).toBe("/approvals");
    expect(text(crumbs)).toContain("Request");
    expect(text(doc.querySelector(".ap-side .ap-status .badge"))).toBe("Pending");
    expect(doc.querySelector(".ap-meta .badge")).toBeNull();
  });

  it("shows a long body's first lines with Show all, and attachments as file chips", () => {
    const doc = render(PENDING_REQUEST);
    const more = doc.querySelector('details[data-heel-fold="body"] > summary');
    expect(text(more)).toMatch(/^Show all \d+ lines$/);
    const chips = [...doc.querySelectorAll(".ap-files .ap-file")].map((c) => text(c));
    expect(chips.length).toBeGreaterThan(0);
    expect(text(doc)).toContain("Not opened by heel.");
  });

  it("says which client the agent used, or heel run, and nothing when it's unknown", () => {
    const meta = (request: ApprovalRequestView) => text(render(request).querySelector(".ap-meta"));
    expect(meta(PENDING_REQUEST)).toContain("via Claude Code");
    expect(meta({ ...PENDING_REQUEST, client: null, surface: "cli" })).toContain("via heel run");
    expect(meta({ ...PENDING_REQUEST, client: null, surface: "http" })).toContain(
      "via the HTTP proxy",
    );
    expect(meta({ ...PENDING_REQUEST, client: null, surface: "mcp" })).not.toContain("via");
  });

  it("shows an HTTP request's body decoded, so the approver reads what will be written", () => {
    const doc = render(HTTP_REQUEST);
    // The operation the account's OpenAPI file names comes after what it calls.
    expect(text(doc.querySelector("h1"))).toBe(
      "ops-bot wants to call PUT /items/5 (item.write) on api",
    );
    expect(text(render({ ...HTTP_REQUEST, action: null }).querySelector("h1"))).toBe(
      "ops-bot wants to call PUT /items/5 on api",
    );
    const card = text(doc.querySelector("section[aria-labelledby^='http-']"));
    expect(card).toContain("attacker@evil.example");
    expect(card).toContain("99999");
  });

  it("shows a merge and a tool without its own view as readable rows", () => {
    const merge = text(render(MERGE_REQUEST).querySelector("section[aria-labelledby^='merge-']"));
    for (const fact of ["acme/web", "#1234", "main", "squash", "9f2c4e1a7b"]) {
      expect(merge).toContain(fact);
    }
    const generic = text(
      render(GENERIC_REQUEST).querySelector("section[aria-labelledby^='what-']"),
    );
    for (const fact of ["payment_intent", "pi_3Q8k2L", "amount", "4500"]) {
      expect(generic).toContain(fact);
    }
  });

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
      // The first lines and the folded rest join back into the exact body.
      expect(bodyText(doc)).toBe(LONG_BODY);
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
        // No form, submit control or link on the page can carry a decision. The one
        // exception is cancelling a waiting task: it posts to the route that stops the
        // task (never approves anything) and carries no decision fields.
        const isStop = (form: UiElement) =>
          /^\/approvals\/[^/]+\/stop-script$/.test(form.getAttribute("action") ?? "");
        for (const form of main.querySelectorAll("form")) {
          if (isStop(form)) {
            const names = [...form.querySelectorAll("input")].map((i) => i.getAttribute("name"));
            expect(names).toEqual(["csrf"]);
            continue;
          }
          expect(form.getAttribute("action") ?? "").not.toMatch(/approv|decid|deny|resume/i);
        }
        expect(
          [
            ...main.querySelectorAll("input[type=submit], button[type=submit], button:not([type])"),
          ].filter((b) => {
            const form = b.closest("form");
            return form === null || !isStop(form);
          }),
        ).toHaveLength(0);
        for (const a of main.querySelectorAll("a[href]")) {
          // The breadcrumb back to the list is a plain GET of the list, never a decision.
          if (a.closest(".ap-crumbs") && a.getAttribute("href") === "/approvals") continue;
          expect(a.getAttribute("href") ?? "").not.toMatch(/approv|decid|deny/i);
        }
        // Every decision button is a plain button that names its ceremony handler.
        for (const b of main.querySelectorAll("button")) {
          const form = b.closest("form");
          if (form !== null && isStop(form)) continue;
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
      // Approve once and deny sit on the bar; standing is behind "Approve for longer".
      expect(buttons.map((b) => b.getAttribute("data-heel-ceremony"))).toEqual([
        "approve-once",
        "deny",
        "approve-standing",
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

  it("offers 1 h, 1 day, 7 days and 30 days; exact call, rule match or this run; at most 30 days", () => {
    const doc = render(PENDING_REQUEST);
    const options = [...doc.querySelectorAll("fieldset select option")].map((o) =>
      o.getAttribute("value"),
    );
    expect(options).toEqual(STANDING_DURATIONS.map((d) => d.value));
    expect(options).toEqual(["1h", "1d", "7d", "30d"]);
    const scopes = [...doc.querySelectorAll("fieldset input[type=radio]")].map((r) =>
      r.getAttribute("value"),
    );
    expect(scopes).toEqual(
      PENDING_REQUEST.runId === null ? ["exact_call", "rule"] : ["exact_call", "rule", "run"],
    );
    const runless = render({ ...PENDING_REQUEST, runId: null });
    expect(
      [...runless.querySelectorAll("fieldset input[type=radio]")].map((r) =>
        r.getAttribute("value"),
      ),
    ).toEqual(["exact_call", "rule"]);
    expect(doc.querySelector("fieldset input[value=exact_call]")?.hasAttribute("checked")).toBe(
      true,
    );
    expect(text(doc.querySelector("fieldset"))).toContain("at most 30 days");
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

  it("names the biggest risk from the stored call, just above the decision buttons", () => {
    expect(biggestRisk(PENDING_REQUEST)).toMatch(
      /^Goes to \d+ people outside your domain \(vendor\.com\)\.$/,
    );
    expect(biggestRisk(MERGE_REQUEST)).toBe("Merges into main in acme/web.");
    expect(biggestRisk(GENERIC_REQUEST)).toBeNull();
    const doc = render(PENDING_REQUEST);
    const risk = doc.querySelector(".ap-decide .ap-risk");
    expect(text(risk)).toContain("outside your domain");
    // It sits before the buttons, inside the decision section.
    expect(doc.querySelector(".ap-decide > .ap-risk + .ap-bar")).not.toBeNull();
    // The agent's reason never feeds it.
    const said = { ...PENDING_REQUEST, reason: "Goes to nobody outside" };
    expect(biggestRisk(said)).toBe(biggestRisk(PENDING_REQUEST));
  });
});
