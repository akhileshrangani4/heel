import { describe, expect, it } from "vitest";
import { OUTLOOK_TOOLS } from "../../../src/definitions/outlook/definition.ts";
import { type FakeGraphMessage, MAILBOX } from "../../helpers/fake-graph.ts";
import { outlookPipeline } from "../../helpers/outlook-pipeline.ts";

/**
 * The Outlook definition (D9b) through the real pipeline, against a fake
 * Graph mailbox: reads with hiding, sending with derived recipients and
 * pinned content, removals by folder id, and inbox rules.
 */

const ALL = `rules:
  - match: { kind: read }
    then: allow
  - match: { action: email.send }
    then: allow
  - match: { action: email.draft }
    then: allow
  - match: { action: email.remove }
    then: allow
  - match: { action: email.label }
    then: allow
`;

const MAIL: FakeGraphMessage[] = [
  {
    id: "o1",
    conversationId: "c1",
    folder: "sentitems",
    from: MAILBOX,
    to: ["bob@company.com"],
    cc: ["carol@company.com"],
    subject: "Plan",
    internetMessageId: "<o1@company.com>",
    text: "Here's the plan",
    received: "2026-11-17T08:00:00Z",
  },
  {
    id: "o2",
    conversationId: "c1",
    folder: "inbox",
    from: "bob@company.com",
    to: [MAILBOX],
    cc: ["carol@company.com", "dave@vendor.com"],
    replyTo: ["bob-replies@company.com"],
    subject: "Re: Plan",
    internetMessageId: "<o2@company.com>",
    text: "Looks good",
    received: "2026-11-17T09:00:00Z",
  },
  {
    id: "o3",
    conversationId: "c2",
    folder: "inbox",
    from: "sarah@example.com",
    to: [MAILBOX],
    subject: "Family dinner",
    categories: ["Family"],
    text: "Sunday?",
  },
];

function setUp(owner = ALL, org?: string) {
  const h = outlookPipeline({ owner, ...(org === undefined ? {} : { org }) });
  h.graph.add(...MAIL);
  return h;
}

const FAMILY = "hide:\n  - email: { labels: { any_of: [Family] } }\n";
const MESSAGE = { from: MAILBOX, to: ["Bob@Company.com"], subject: "Hi", body: "Hello" };

describe("Outlook tools", () => {
  it("I-20: marks only the read tools read-only", () => {
    expect(
      OUTLOOK_TOOLS.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
    ).toEqual([
      "search",
      "get_message",
      "get_thread",
      "list_folders",
      "list_rules",
      "list_send_as",
    ]);
  });
});

describe("reads", () => {
  it("I-41: search drops hidden messages (by category) and counts them", async () => {
    const h = setUp(`${ALL}${FAMILY}`);
    const result = await h.call("search", { query: "" });
    expect(result).toMatchObject({ status: "allowed", result: { hidden: { count: 1 } } });
    expect(JSON.stringify(result)).not.toContain("sarah@example.com");
  });

  it("I-42: get_message refuses a hidden and a missing message the same way", async () => {
    const h = setUp(`${ALL}${FAMILY}`);
    const hidden = await h.call("get_message", { message_id: "o3" });
    expect(hidden).toEqual({ status: "denied", reason: "not_available", rule: null });
    expect(await h.call("get_message", { message_id: "nope" })).toEqual(hidden);
  });

  it("get_thread returns the conversation in order, with folder names as labels", async () => {
    const h = setUp();
    expect(await h.call("get_thread", { conversation_id: "c1" })).toMatchObject({
      status: "allowed",
      result: {
        messages: [
          { id: "o1", labels: ["Sent Items"] },
          { id: "o2", labels: ["Inbox"] },
        ],
        hidden: { count: 0 },
      },
    });
  });

  it("refuses a paging link that points anywhere but this mailbox on Graph", async () => {
    const h = setUp();
    const result = await h.call("search", {
      query: "",
      page_token: "https://evil.example/collect",
    });
    expect(result).toMatchObject({ status: "denied", reason: "unsupported" });
    expect(h.graph.requests.some((r) => r.includes("evil"))).toBe(false);
  });
});

describe("sending", () => {
  it("I-19: sends composed MIME with exactly the checked recipients", async () => {
    const h = setUp();
    const result = await h.call("send", { ...MESSAGE, bcc: ["x@else.com"] });
    expect(result).toMatchObject({ status: "allowed" });
    const headers = h.graph.sent[0]?.headers ?? {};
    expect(headers["to"]).toBe("bob@company.com");
    expect(headers["bcc"]).toBe("x@else.com");
  });

  it("refuses a from other than the mailbox", async () => {
    const h = setUp();
    expect(await h.call("send", { ...MESSAGE, from: "boss@company.com" })).toEqual({
      status: "denied",
      reason: "sender_not_allowed",
      rule: null,
    });
  });

  it("reply goes to Reply-To; reply to your own sent message goes to its To", async () => {
    const h = setUp();
    await h.call("reply", { message_id: "o2", from: MAILBOX, body: "Thanks" });
    await h.call("reply", { message_id: "o1", from: MAILBOX, body: "Ping" });
    expect(h.graph.sent.map((s) => s.headers["to"])).toEqual([
      "bob-replies@company.com",
      "bob@company.com",
    ]);
    expect(h.graph.sent[0]?.headers["in-reply-to"]).toBe("<o2@company.com>");
  });

  it("I-21: all_in_thread counts only Sent Items, so someone who only wrote in fails", async () => {
    const h = setUp(`rules:
  - match: { action: email.send, recipients: { all_in_thread: true } }
    then: allow
`);
    expect(await h.call("reply", { message_id: "o1", from: MAILBOX, body: "Ping" })).toMatchObject({
      status: "allowed",
    });
    // reply_all on Bob's message adds Dave, whom only Bob cc'd.
    expect(
      await h.call("reply_all", { message_id: "o2", from: MAILBOX, body: "Hi all" }),
    ).toMatchObject({ status: "denied" });
  });

  it("I-21: a forged From of the mailbox in the inbox isn't the mailbox's own", async () => {
    const h = setUp(`rules:
  - match: { action: email.send, recipients: { all_in_thread: true } }
    then: allow
`);
    h.graph.add({
      id: "f1",
      conversationId: "c9",
      folder: "inbox",
      from: MAILBOX,
      to: ["attacker@evil.com"],
      subject: "From 'Alice'",
      text: "x",
    });
    expect(
      await h.call("reply_all", { message_id: "f1", from: MAILBOX, body: "Hi" }),
    ).toMatchObject({ status: "denied" });
    expect(h.graph.sent).toEqual([]);
  });

  it("send_draft sends the checked MIME and refuses a draft changed after the check", async () => {
    const h = setUp();
    const created = await h.call("create_draft", { ...MESSAGE, bcc: ["x@else.com"] });
    const draftId = (created as { result: { draft_id: string } }).result.draft_id;
    expect(await h.call("send_draft", { draft_id: draftId })).toMatchObject({ status: "allowed" });
    expect(h.graph.sent[0]?.headers["bcc"]).toBe("x@else.com");

    const again = await h.call("create_draft", MESSAGE);
    const second = (again as { result: { draft_id: string } }).result.draft_id;
    let reads = 0;
    h.graph.afterMimeRead = () => {
      reads += 1;
      const draft = h.graph.messages.get(second);
      if (reads === 2 && draft !== undefined)
        draft.mime = (draft.mime ?? "").replace("bob@", "eve@");
    };
    expect(await h.call("send_draft", { draft_id: second })).toMatchObject({
      status: "upstream_error",
      upstreamStatus: 409,
    });
    expect(h.graph.sent).toHaveLength(1);
  });

  it("refuses send_draft on a message that isn't a draft", async () => {
    const h = setUp();
    expect(await h.call("send_draft", { draft_id: "o2" })).toEqual({
      status: "denied",
      reason: "not_available",
      rule: null,
    });
  });
});

describe("removing and filtering", () => {
  const counted = (h: ReturnType<typeof setUp>) =>
    h.t.store.sqlite
      .prepare(
        "select json_extract(fields, '$.action') as action, items from count_events order by id",
      )
      .all();

  it("trash is email.remove and counts every message", async () => {
    const h = setUp();
    expect(await h.call("trash", { message_ids: ["o1", "o2"] })).toMatchObject({
      status: "allowed",
    });
    expect(counted(h)).toEqual([{ action: "email.remove", items: 2 }]);
    expect(h.graph.messages.get("o1")?.folder).toBe(h.graph.folderId("deleteditems"));
  });

  it("a move is email.remove by folder id, not by name, and email.label otherwise", async () => {
    const h = setUp(`rules:
  - match: { action: email.label }
    then: allow
`);
    expect(
      await h.call("move", { message_ids: ["o2"], folder: h.graph.folderId("projects") }),
    ).toMatchObject({ status: "allowed" });
    expect(
      await h.call("move", { message_ids: ["o2"], folder: h.graph.folderId("deleteditems") }),
    ).toMatchObject({ status: "denied" });
    expect(await h.call("move", { message_ids: ["o2"], folder: "junkemail" })).toMatchObject({
      status: "denied",
    });
  });

  it("I-70: a forwarding inbox rule is email.send and needs a rule that names it", async () => {
    const broad = setUp(`rules:
  - match: { kind: write }
    then: allow
`);
    const rule = {
      name: "Bank to me",
      conditions: { from_addresses: ["bank@example.com"] },
      forward_to: ["me@elsewhere.com"],
    };
    expect(await broad.call("create_rule", rule)).toEqual({
      status: "denied",
      reason: "persistence_unnamed",
      rule: null,
    });
    const named = setUp(`rules:
  - match: { tool: create_rule }
    then: allow
`);
    expect(await named.call("create_rule", rule)).toMatchObject({ status: "allowed" });
    expect(named.graph.rules).toHaveLength(1);
  });
});
