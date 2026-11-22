import { describe, expect, it } from "vitest";
import { suggestRules } from "../../src/core/suggestions.ts";
import { ORG_DEFAULT, setMode } from "../../src/store/modes.ts";
import { pendingId, SEND } from "../helpers/approvals.ts";
import { humanPlaneHarness } from "../helpers/human-plane.ts";
import { oneRule } from "../helpers/pipeline.ts";

/** Observability (A5): the inventory, the explorer, the live stream and rule suggestions. */

const DENY_SENDS = oneRule("{ action: email.send }", "deny");

describe("suggestRules", () => {
  it("groups stopped calls by account and action, most seen first; sends are suggested as ask", () => {
    const suggestions = suggestRules([
      { account: "gmail-work", action: "email.send", tool: "send", args: { to: ["a@vendor.com"] } },
      {
        account: "gmail-work",
        action: "email.send",
        tool: "send",
        args: { to: ["b@vendor.com"], cc: ["c@partner.io"] },
      },
      { account: "notes", action: null, tool: "create_page", args: {} },
    ]);
    expect(suggestions.map((s) => [s.subject, s.seen])).toEqual([
      ["email.send", 2],
      ["create_page", 1],
    ]);
    expect(suggestions[0]?.yaml).toBe(
      "- match: { account: gmail-work, action: email.send, recipients: { all_domain_in: [partner.io, vendor.com] } }\n  then: ask  # seen 2 times",
    );
    expect(suggestions[1]?.yaml).toContain("tool: create_page");
  });
});

describe("the Activity and Agents pages", () => {
  it("lists decisions newest first, filters them, and suggests rules from shadow traffic", async () => {
    const h = humanPlaneHarness({ owner: DENY_SENDS });
    const admin = await h.signIn(await h.enroll());
    await h.call({ args: SEND });
    setMode(h.t.db, {
      orgId: h.t.orgId,
      ownerId: ORG_DEFAULT,
      mode: "shadow",
      by: "x",
      at: new Date(),
    });
    await h.call({ args: { ...SEND, to: ["x@vendor.com"] } });

    const page = await (await h.fetch("/activity", { as: admin })).text();
    expect(page).toContain("would deny");
    expect(page).toContain("deny");
    expect(page).toContain("Suggested from Watch mode");
    expect(page).toContain("action: email.send");

    const filtered = await (await h.fetch("/activity?kind=would_deny", { as: admin })).text();
    expect(filtered.match(/<tr data-id=/g)).toHaveLength(1);
  });

  it("shows a member only their own agents' decisions", async () => {
    const h = humanPlaneHarness({ owner: DENY_SENDS });
    await h.call({ args: SEND });
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));
    const page = await (await h.fetch("/activity", { as: sam })).text();
    expect(page.match(/<tr data-id=/g)).toBeNull();
    const agents = await (await h.fetch("/agents", { as: sam })).text();
    expect(agents).not.toContain("inbox-bot");
  });

  it("counts each agent's decisions in the inventory", async () => {
    const h = humanPlaneHarness({ owner: oneRule("{ action: email.send }", "ask") });
    const admin = await h.signIn(await h.enroll());
    pendingId(await h.call({ args: SEND }));
    const page = await (await h.fetch("/agents", { as: admin })).text();
    expect(page).toContain("inbox-bot");
    expect(page).toContain("gmail-work");
  });

  it("streams new decisions as server-sent events", async () => {
    const h = humanPlaneHarness({ owner: DENY_SENDS });
    const admin = await h.signIn(await h.enroll());
    await h.call({ args: SEND });
    const controller = new AbortController();
    const response = await h.fetch("/activity/stream?after=0", {
      as: admin,
      signal: controller.signal,
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    const first = await reader?.read();
    controller.abort();
    await reader?.cancel().catch(() => {});
    const text = new TextDecoder().decode(first?.value);
    expect(text).toContain("event: row");
    expect(text).toContain("id: ");
  });
});
