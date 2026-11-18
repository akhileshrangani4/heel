import { describe, expect, it } from "vitest";
import type { LooksLikeJudge } from "../../../src/core/hide.ts";
import { GMAIL_TOOLS } from "../../../src/definitions/gmail/definition.ts";
import { nativeResult } from "../../../src/gateway/mcp/results.ts";
import type { FakeMessage } from "../../helpers/fake-gmail.ts";
import { gmailPipeline } from "../../helpers/gmail-pipeline.ts";

/**
 * Gmail's read tools (D9a-1b) through the real pipeline, against a fake
 * mailbox: what an agent sees, what heel hides, and which reads it makes.
 */

const READS = "rules:\n  - match: { kind: read }\n    then: allow\n";

const FAMILY = "  - email: { from: { any_of: [sarah@example.com] } }\n";
const RESETS = "  - email: { looks_like: [password_reset] }\n";

const LUNCH: FakeMessage = {
  id: "m1",
  threadId: "t1",
  from: "Bob <bob@company.com>",
  to: "alice@company.com",
  subject: "Lunch?",
  text: "Free on Friday?",
};
const MOM: FakeMessage = {
  id: "m2",
  threadId: "t1",
  from: "Sarah <sarah@example.com>",
  to: "alice@company.com",
  subject: "Re: Lunch?",
  text: "Call me",
};
const RESET: FakeMessage = {
  id: "m3",
  threadId: "t2",
  from: "no-reply@service.example",
  to: "alice@company.com",
  subject: "Reset your password",
  text: "We received a request to reset your password.",
};

function setUp(options: { hide?: string; judge?: LooksLikeJudge } = {}) {
  const h = gmailPipeline({
    owner: options.hide === undefined ? READS : `${READS}hide:\n${options.hide}`,
    ...(options.judge !== undefined && { judge: options.judge }),
  });
  h.gmail.add(LUNCH, MOM, RESET);
  return h;
}

const noMatch: LooksLikeJudge = () => "no_match";
const matchResets: LooksLikeJudge = (m) => (m.subject.includes("Reset") ? "match" : "no_match");

describe("Gmail tools", () => {
  it("I-20: marks only the read tools read-only", () => {
    const readOnly = GMAIL_TOOLS.filter((t) => t.annotations?.readOnlyHint === true).map(
      (t) => t.name,
    );
    expect(readOnly).toEqual([
      "search",
      "get_message",
      "get_thread",
      "list_labels",
      "list_send_as",
      "list_filters",
    ]);
  });

  it("denies arguments outside a tool's schema", async () => {
    const { call, gmail } = setUp();
    expect(await call("get_message", { message_id: "m1", extra: true })).toMatchObject({
      status: "denied",
      reason: "unsupported",
    });
    expect(await call("send", {})).toMatchObject({ status: "denied", reason: "unsupported" });
    expect(gmail.requests).toEqual([]);
  });
});

describe("search", () => {
  it("returns summaries built field by field, with a zero hidden count", async () => {
    const { call } = setUp();
    const result = await call("search", { query: "in:inbox", max_results: 2 });
    expect(result).toMatchObject({
      status: "allowed",
      result: {
        messages: [
          { id: "m3", subject: "Reset your password", labels: ["INBOX"] },
          { id: "m2", from: "Sarah <sarah@example.com>" },
        ],
        next_page_token: "page-2",
        hidden: { count: 0 },
      },
    });
    const first = (result as { result: { messages: object[] } }).result.messages[0];
    expect(Object.keys(first ?? {}).sort()).toEqual(
      ["cc", "date", "from", "id", "labels", "snippet", "subject", "thread_id", "to"].sort(),
    );
  });

  it("I-40, I-41: drops hidden messages entirely and counts them once", async () => {
    const { call, hidden } = setUp({ hide: FAMILY });
    const result = await call("search", { query: "" });
    expect(result).toMatchObject({ status: "allowed", result: { hidden: { count: 1 } } });
    const text = JSON.stringify(result);
    expect(text).not.toContain("sarah@example.com");
    expect(text).not.toContain("m2");
    expect(text).not.toContain("Call me");
    expect(hidden).toEqual(["matched"]);
  });

  it("reads no bodies when no entry uses looks_like", async () => {
    const { call, gmail } = setUp({ hide: FAMILY });
    await call("search", { query: "" });
    expect(gmail.requests.filter((r) => r.includes("format=full"))).toEqual([]);
  });

  it("reads bodies for looks_like and hides what the judge flags", async () => {
    const { call, gmail } = setUp({ hide: RESETS, judge: matchResets });
    const result = await call("search", { query: "" });
    expect(result).toMatchObject({ status: "allowed", result: { hidden: { count: 1 } } });
    expect(JSON.stringify(result)).not.toContain("Reset your password");
    expect(gmail.requests.filter((r) => r.includes("format=full"))).toHaveLength(3);
  });

  it("I-44: hides every message a looks_like entry covers when no judge is wired", async () => {
    const { call } = setUp({ hide: RESETS });
    const result = await call("search", { query: "" });
    expect(result).toMatchObject({
      status: "allowed",
      result: { messages: [], hidden: { count: 3 } },
    });
  });

  it("hides a message carrying a label heel can't name", async () => {
    const { call, gmail } = setUp({ hide: FAMILY });
    gmail.add({ ...LUNCH, id: "m9", labelIds: ["Label_unknown"] });
    const result = await call("search", { query: "" });
    expect(JSON.stringify(result)).not.toContain("m9");
  });
});

describe("get_message", () => {
  it("returns the whole message", async () => {
    const { call } = setUp();
    expect(await call("get_message", { message_id: "m1" })).toMatchObject({
      status: "allowed",
      result: {
        id: "m1",
        thread_id: "t1",
        from: "Bob <bob@company.com>",
        body: "Free on Friday?",
        body_format: "text",
        attachments: [],
      },
    });
  });

  it("I-42: denies a hidden target and a missing one the same way", async () => {
    const { call } = setUp({ hide: FAMILY });
    const hidden = await call("get_message", { message_id: "m2" });
    const missing = await call("get_message", { message_id: "nope" });
    expect(hidden).toEqual({ status: "denied", reason: "not_available", rule: null });
    expect(missing).toEqual(hidden);
  });

  it("I-44: hides an encrypted message from a looks_like entry", async () => {
    const { call, gmail } = setUp({ hide: RESETS, judge: noMatch });
    gmail.add({
      ...LUNCH,
      id: "m8",
      payload: { mimeType: "application/pkcs7-mime", body: { size: 10 } },
    });
    expect(await call("get_message", { message_id: "m8" })).toMatchObject({
      status: "denied",
      reason: "not_available",
    });
    // The judge's no_match still lets an ordinary message through.
    expect(await call("get_message", { message_id: "m1" })).toMatchObject({ status: "allowed" });
  });
});

describe("get_thread", () => {
  it("I-40: drops hidden messages from a thread and counts them", async () => {
    const { call } = setUp({ hide: FAMILY });
    const result = await call("get_thread", { thread_id: "t1" });
    expect(result).toMatchObject({
      status: "allowed",
      result: { id: "t1", messages: [{ id: "m1" }], hidden: { count: 1 } },
    });
    expect(JSON.stringify(result)).not.toContain("Call me");
  });

  it("I-42: denies a thread whose every message is hidden", async () => {
    const { call } = setUp({ hide: RESETS, judge: matchResets });
    expect(await call("get_thread", { thread_id: "t2" })).toEqual({
      status: "denied",
      reason: "not_available",
      rule: null,
    });
  });
});

describe("list_labels", () => {
  it("lists label ids, names and types", async () => {
    const { call } = setUp();
    expect(await call("list_labels")).toMatchObject({
      status: "allowed",
      result: { labels: [{ id: "INBOX" }, { id: "SENT" }, { id: "Label_1", name: "Family" }] },
    });
  });
});

describe("the MCP result for a built-in tool", () => {
  it("carries the data twice and says how many items were hidden", () => {
    const result = nativeResult({ messages: [], hidden: { count: 2 } });
    expect(result.structuredContent).toEqual({ messages: [], hidden: { count: 2 } });
    expect(result.content).toEqual([
      { type: "text", text: '{"messages":[],"hidden":{"count":2}}' },
      { type: "text", text: "heel hid 2 items from this result." },
    ]);
  });
});
