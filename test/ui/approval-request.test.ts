import { describe, expect, it } from "vitest";
import {
  type ApprovalRequestProps,
  type ApprovalRequestView,
  allowLabel,
  approvalRequest,
  biggestRisk,
  STANDING_DURATIONS,
} from "../../src/web/ui/approval-request.ts";
import { formatArguments } from "../../src/web/ui/format.ts";
import {
  AGENT_PAUSE,
  APPROVED_REQUEST,
  DENIED_DRAFT_REQUEST,
  DENIED_REQUEST,
  DRAFT_REQUEST,
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
  SPARSE_REQUEST,
  TASK_REQUEST,
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

  it("quotes the agent's reason whole, marked as its words, as text, and shows nothing without one", () => {
    const reason = text(render(PENDING_REQUEST).querySelector("figure.reason"));
    expect(reason).toContain("The agent says");
    expect(reason).toContain("Not checked");
    expect(reason).toContain(PENDING_REQUEST.reason);
    const long = `${"word ".repeat(60)}END`;
    expect(text(render({ ...PENDING_REQUEST, reason: long }).querySelector("blockquote"))).toBe(
      long.trim(),
    );
    expect(text(render(DENIED_REQUEST).querySelector("figure.reason"))).toContain(
      PENDING_REQUEST.reason,
    );
    const marked = render({ ...PENDING_REQUEST, reason: "<b>trust me</b>" });
    expect(marked.querySelector("figure.reason b")).toBeNull();
    expect(text(marked.querySelector("figure.reason blockquote"))).toBe("<b>trust me</b>");
    expect(render({ ...PENDING_REQUEST, reason: null }).querySelector("figure.reason")).toBeNull();
  });

  it("shows a step of a longer task in plain words, with the agent's code folded, as text (C3)", () => {
    const doc = render({
      ...PENDING_REQUEST,
      script: {
        code: 'import gmail_work\nmsgs = gmail_work.search(query="invoices")\n<script>alert(1)</script>',
        truncated: false,
        before: [{ account: "gmail-work", tool: "search", decision: "allow" }],
      },
    });
    expect(text(doc.querySelector(".ap-taskrow"))).toContain("Part of a longer task: step 2");
    const section = doc.querySelector("section.ap-task");
    if (section === null) throw new Error("no task section");
    expect(text(section)).toContain("Part of a longer task");
    expect(text(section)).toContain("Search Allowed");
    expect(text(section)).toContain("See the code the agent wrote");
    expect(text(section)).toContain("<script>alert(1)</script>");
    expect(section.querySelector("script")).toBeNull();
    expect(section.querySelector("details[data-heel-fold='code']")?.hasAttribute("open")).toBe(
      false,
    );
    // One decision, no stop control, and never the word "script" on the page.
    expect(section.querySelector("form")).toBeNull();
    expect(text(render(TASK_REQUEST))).not.toMatch(/\bscript\b/i);

    const plain = render(PENDING_REQUEST);
    expect(plain.querySelector("section.ap-task")).toBeNull();
    expect(plain.querySelector(".ap-taskrow")).toBeNull();
  });

  it("leads with who asks, named once, then heel's own sentence, built from the call", () => {
    const doc = render(PENDING_REQUEST);
    expect(text(doc.querySelector(".ap-who"))).toBe("I inbox-bot");
    expect(text(doc.querySelector("h1"))).toBe("Send an email to 41 people from gmail-work");
    // The agent's reason can't change the sentence.
    const lying = render({ ...PENDING_REQUEST, reason: "Replying only to Bob" });
    expect(text(lying.querySelector("h1"))).toContain("41 people");
    expect(text(render(MERGE_REQUEST).querySelector("h1"))).toBe(
      "Merge pull request #1234 on acme/web into main",
    );
    expect(text(render(GENERIC_REQUEST).querySelector("h1"))).toBe(
      "Refund a Stripe payment on stripe",
    );
    expect(text(render(DRAFT_REQUEST).querySelector("h1"))).toBe("Save an email draft in personal");
    // The name isn't repeated in the page's own words.
    const words = text(doc).replace(text(doc.querySelector(".ap-who")), "");
    expect(words).not.toContain("inbox-bot says");
  });

  it("cuts long names in the title only, keeping the first 12 and last 8 characters", () => {
    const long = "eve.long-surname-for-wrapping@a-very-long-partner-domain.example";
    const email = PENDING_REQUEST.email;
    if (!email) throw new Error("PENDING_REQUEST fixture must carry an email preview");
    const doc = render({ ...PENDING_REQUEST, email: { ...email, to: [long], cc: [] } });
    expect(text(doc.querySelector("h1"))).toBe(
      "Send an email to eve.long-sur….example from gmail-work",
    );
    // Whole in the email itself (I-57).
    expect(text(doc.querySelector("section[aria-labelledby^='email-']"))).toContain(long);
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

  it("leads with a link back to the list, and shows no status badge", () => {
    const doc = render(PENDING_REQUEST);
    const crumbs = doc.querySelector("nav.ap-crumbs");
    expect(crumbs?.querySelector("a")?.getAttribute("href")).toBe("/approvals");
    expect(text(crumbs)).toBe("Approvals");
    expect(doc.querySelector(".ap .badge")).toBeNull();
  });

  it("shows a long body's first lines with Show all, and attachments as file chips", () => {
    const doc = render(PENDING_REQUEST);
    const more = doc.querySelector('details[data-heel-fold="body"] > summary');
    expect(text(more)).toMatch(/^Show all \d+ lines$/);
    const chips = [...doc.querySelectorAll(".ap-files .ap-file")].map((c) => text(c));
    expect(chips.length).toBeGreaterThan(0);
    expect(doc.querySelector(".ap-files")?.getAttribute("aria-label")).toContain(
      "not opened by heel",
    );
  });

  it("names empty cc and bcc on one line instead of a row each", () => {
    const doc = render(DRAFT_REQUEST);
    expect(text(doc.querySelector(".ap-none"))).toBe("No cc or bcc");
    expect(text(render(PENDING_REQUEST).querySelector(".ap-none"))).toBe("No bcc");
    expect(text(render(SPARSE_REQUEST).querySelector(".ap-none"))).toBe(
      "Left empty: assignee_id, cycle_id, estimate, labels, parent_id, project_id",
    );
  });

  it("says which client the agent used, or heel run, in Technical", () => {
    const tech = (request: ApprovalRequestView) =>
      text(render(request).querySelector(".ap-technical"));
    expect(tech(PENDING_REQUEST)).toContain("Claude Code, as it named itself");
    expect(tech({ ...PENDING_REQUEST, client: null, surface: "cli" })).toContain("heel run");
    expect(tech({ ...PENDING_REQUEST, client: null, surface: "http" })).toContain("The HTTP proxy");
  });

  it("Details has four plain rows without the agent's name; the rest is in Technical", () => {
    const doc = render(PENDING_REQUEST);
    const rows = [...doc.querySelectorAll(".ap-details > .ap-fold-body > .ap-row")].map((r) =>
      text(r),
    );
    expect(rows).toEqual([
      "Accountgmail-work, Gmail",
      "What it doesSend an email",
      "Rule‘client sends ask’ asked you",
      "ExpiresIn 23 h 48 min",
    ]);
    expect(rows.join(" ")).not.toContain("inbox-bot");
    expect(doc.querySelector(".ap-details details.ap-technical")).not.toBeNull();
    expect(doc.querySelector(".ap-technical details")).toBeNull();
  });

  it("keeps at most one top-level fold open: they share one name", () => {
    const doc = render(TASK_REQUEST);
    const names = [
      ...doc.querySelectorAll(
        "details[data-heel-fold='args'], details[data-heel-fold='details'], details[data-heel-fold='code'], details.ap-split-menu",
      ),
    ].map((d) => d.getAttribute("name"));
    expect(names).toEqual(["ap-one", "ap-one", "ap-one", "ap-one"]);
  });

  it("shows an HTTP request's body decoded, so the approver reads what will be written", () => {
    const doc = render(HTTP_REQUEST);
    // The operation the account's OpenAPI file names comes after what it calls.
    expect(text(doc.querySelector("h1"))).toBe("Call PUT /items/5 (item.write) on api");
    expect(text(render({ ...HTTP_REQUEST, action: null }).querySelector("h1"))).toBe(
      "Call PUT /items/5 on api",
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
        // No form, submit control or link on the page can carry a decision.
        for (const form of main.querySelectorAll("form")) {
          expect(form.getAttribute("action") ?? "").not.toMatch(/approv|decid|deny|resume/i);
        }
        expect(
          main.querySelectorAll("input[type=submit], button[type=submit], button:not([type])"),
        ).toHaveLength(0);
        for (const a of main.querySelectorAll("a[href]")) {
          // The breadcrumb back to the list is a plain GET of the list, never a decision.
          if (a.closest(".ap-crumbs") && a.getAttribute("href") === "/approvals") continue;
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
      // Approve once, then one allow button per choice (CSS shows the chosen one), then Deny.
      const intents = buttons.map((b) => b.getAttribute("data-heel-ceremony"));
      expect(intents[0]).toBe("approve-once");
      expect(intents.at(-1)).toBe("deny");
      expect(new Set(intents.slice(1, -1))).toEqual(new Set(["approve-standing"]));
      for (const b of buttons) {
        expect(b.getAttribute("data-heel-handler")).toBe(DECIDE.handler);
        expect(b.getAttribute("data-approval-id")).toBe(PENDING_REQUEST.id);
        expect(b.getAttribute("data-call-hash")).toBe(PENDING_REQUEST.callHash);
        const help = doc.getElementById(b.getAttribute("aria-describedby") ?? "");
        expect(text(help)).toMatch(/passkey/i);
      }
    });

    it("I-56: each allow button signs exactly the scope and length its label names", () => {
      const doc = render(PENDING_REQUEST);
      const allows = [...doc.querySelectorAll("button[data-heel-ceremony='approve-standing']")];
      expect(allows).toHaveLength(12);
      for (const b of allows) {
        const options = doc.getElementById(b.getAttribute("data-heel-options") ?? "");
        expect(options?.tagName.toLowerCase()).toBe("fieldset");
        const value = (name: string) =>
          options?.querySelector(`input[type=hidden][name=${name}]`)?.getAttribute("value") ?? "";
        const scope = value("scope") as "exact_call" | "rule" | "run";
        expect(text(b)).toBe(allowLabel(scope, value("duration")));
      }
    });
  });

  it("offers 1 h, 1 day, 7 days and 30 days; just once first, then exact call, rule or run; at most 30 days", () => {
    const doc = render(PENDING_REQUEST);
    const menu = doc.querySelector(".ap-menu");
    const durations = [...(menu?.querySelectorAll("input[name=duration]") ?? [])].map((o) =>
      o.getAttribute("value"),
    );
    expect(durations).toEqual(STANDING_DURATIONS.map((d) => d.value));
    expect(durations).toEqual(["1h", "1d", "7d", "30d"]);
    const scopes = [...(menu?.querySelectorAll("input[name=scope]") ?? [])].map((r) =>
      r.getAttribute("value"),
    );
    expect(scopes).toEqual(["once", "exact_call", "rule", "run"]);
    const runless = render({ ...PENDING_REQUEST, runId: null });
    expect(
      [...runless.querySelectorAll(".ap-menu input[name=scope]")].map((r) =>
        r.getAttribute("value"),
      ),
    ).toEqual(["once", "exact_call", "rule"]);
    // The narrowest choice is the default; the broad ones are marked and say what they cover.
    expect(menu?.querySelector("input[value=once]")?.hasAttribute("checked")).toBe(true);
    const broad = [...(menu?.querySelectorAll(".choice.is-broad") ?? [])].map((c) => text(c));
    expect(broad[0]).toBe("Any call the rule ‘client sends ask’ covers Broad");
    expect(text(menu)).toContain("at most 30 days");
    expect(text(menu)).not.toMatch(/standing|rules\/|yaml/i);
  });

  it("org asks are approve-once only, with no standing option (Q-A7)", () => {
    const doc = render(ORG_REQUEST);
    expect(button(doc, "approve-once")).not.toBeNull();
    expect(button(doc, "approve-standing")).toBeNull();
    expect(doc.querySelector(".ap-menu")).toBeNull();
    expect(text(doc)).toContain("Org asks never stand");
  });

  it("I-61: while paused, approving is disabled and deny stays available", () => {
    const doc = render(PENDING_REQUEST, { pause: AGENT_PAUSE });
    expect(button(doc, "approve-once")?.hasAttribute("disabled")).toBe(true);
    for (const b of doc.querySelectorAll("button[data-heel-ceremony='approve-standing']")) {
      expect(b.hasAttribute("disabled")).toBe(true);
    }
    expect(doc.querySelector(".ap-menu fieldset")?.hasAttribute("disabled")).toBe(true);
    expect(button(doc, "deny")?.hasAttribute("disabled")).toBe(false);
    expect(text(doc)).toContain("Approving is unavailable while agent inbox-bot is paused");
  });

  it("I-55: an expired request can't be approved: it has no decision control at all", () => {
    const doc = render(EXPIRED_REQUEST);
    expect(doc.querySelectorAll("button")).toHaveLength(0);
    expect(doc.querySelectorAll("[data-heel-ceremony]")).toHaveLength(0);
    expect(text(doc.querySelector("h1"))).toBe("Expired");
  });

  it.each([
    ["approved", APPROVED_REQUEST, "Approved"],
    ["denied", DENIED_REQUEST, "Denied"],
    ["denied draft", DENIED_DRAFT_REQUEST, "Denied"],
    ["executed", EXECUTED_REQUEST, "Ran"],
    ["expired", EXPIRED_REQUEST, "Expired"],
  ] as const)("a decided (%s) request is one word, then what was asked", (_s, request, word) => {
    const doc = render(request);
    expect(doc.querySelectorAll("button")).toHaveLength(0);
    // The word and nothing else.
    expect(text(doc.querySelector("h1"))).toBe(word);
    expect(text(doc.querySelector(".ap-outcome"))).toBe(word);
    // Then the ask in one sentence, naming the agent once, and the agent's words whole.
    expect(text(doc.querySelector(".ap-title"))).toMatch(new RegExp(`^${request.agent} asked to `));
    expect(text(doc.querySelector("blockquote"))).toBe(request.reason);
    expect(doc.querySelector(".ap-back a")?.getAttribute("href")).toBe("/approvals");
    expect(text(doc.querySelector(".ap-back"))).toBe("Back to Approvals");
    // The content is folded but whole (I-57); who decided and what a resend gets are in Details.
    const asked = doc.querySelector("details[data-heel-fold='asked']");
    expect(asked?.hasAttribute("open")).toBe(false);
    expect(JSON.parse(asked?.querySelector("pre.args")?.textContent ?? "null")).toEqual(
      request.args,
    );
    expect(text(doc.querySelector(".ap-details"))).toContain("same call again");
  });

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

  it("names the biggest risk from the stored call, just above the content", () => {
    expect(biggestRisk(PENDING_REQUEST)).toMatch(
      /^Goes to \d+ people outside your domain \(vendor\.com\)\.$/,
    );
    expect(biggestRisk(MERGE_REQUEST)).toBe("Merges into main in acme/web.");
    expect(biggestRisk(GENERIC_REQUEST)).toBeNull();
    // A draft sends nothing.
    expect(biggestRisk(DRAFT_REQUEST)).toBeNull();
    const doc = render(PENDING_REQUEST);
    expect(text(doc.querySelector(".ap-risk"))).toContain("outside your domain");
    expect(doc.querySelector(".ap-risk + .ap-content")).not.toBeNull();
    // The agent's reason never feeds it.
    const said = { ...PENDING_REQUEST, reason: "Goes to nobody outside" };
    expect(biggestRisk(said)).toBe(biggestRisk(PENDING_REQUEST));
  });
});
