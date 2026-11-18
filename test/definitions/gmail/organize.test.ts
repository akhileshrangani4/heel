import { describe, expect, it } from "vitest";
import { removes } from "../../../src/definitions/gmail/organize.ts";
import type { FakeMessage } from "../../helpers/fake-gmail.ts";
import { gmailPipeline } from "../../helpers/gmail-pipeline.ts";

/**
 * Gmail's remove, label and filter tools (D9a-3) through the real pipeline:
 * which action rules see, how many items a call counts, and what reaches
 * Gmail.
 */

const ORGANIZE = `rules:
  - match: { kind: read }
    then: allow
  - match: { action: email.remove }
    then: allow
  - match: { action: email.label }
    then: allow
`;

const INBOX: FakeMessage[] = Array.from({ length: 5 }, (_, i) => ({
  id: `m${i}`,
  threadId: i < 3 ? "t1" : `t${i}`,
  from: i === 4 ? "Sarah <sarah@example.com>" : "Bob <bob@company.com>",
  to: "alice@company.com",
  subject: `Message ${i}`,
  labelIds: ["INBOX"],
  text: "Hello",
}));

const FAMILY = "hide:\n  - email: { from: { any_of: [sarah@example.com] } }\n";

function setUp(owner = ORGANIZE, org?: string) {
  const h = gmailPipeline({ owner, ...(org === undefined ? {} : { org }) });
  h.gmail.add(...INBOX.map((m) => ({ ...m })));
  return h;
}

const counted = (h: ReturnType<typeof setUp>) =>
  h.t.store.sqlite
    .prepare(
      "select json_extract(fields, '$.action') as action, items from count_events order by id",
    )
    .all() as {
    action: string;
    items: number;
  }[];

describe("what counts as a removal", () => {
  it("is trash, spam and leaving the inbox; other label changes are not", () => {
    expect(removes(["TRASH"], [])).toBe(true);
    expect(removes(["SPAM"], [])).toBe(true);
    expect(removes([], ["INBOX"])).toBe(true);
    expect(removes(["Label_1"], ["UNREAD"])).toBe(false);
  });
});

describe("archive and trash", () => {
  it("archive is email.remove and counts every message in the batch", async () => {
    const h = setUp();
    const result = await h.call("archive", { message_ids: ["m0", "m1", "m1", "m2"] });
    expect(result).toMatchObject({ status: "allowed", result: { changed: 3 } });
    expect(counted(h)).toEqual([{ action: "email.remove", items: 3 }]);
    expect(h.gmail.messages.get("m0")?.labelIds).toEqual([]);
  });

  it("a removal limit counts messages, not calls", async () => {
    const h = setUp(`rules:
  - match: { action: email.remove, items: { over: 3, per: hour } }
    then: deny
${ORGANIZE.replace("rules:\n", "")}`);
    expect(await h.call("trash", { message_ids: ["m0", "m1"] })).toMatchObject({
      status: "allowed",
    });
    expect(await h.call("trash", { message_ids: ["m2", "m3"] })).toMatchObject({
      status: "denied",
    });
    expect(h.gmail.messages.get("m2")?.labelIds).toEqual(["INBOX"]);
  });

  it("reports a trash that failed part way as an unknown outcome", async () => {
    const h = setUp();
    const result = await h.call("trash", { message_ids: ["m0", "m1", "gone"] });
    expect(result).toEqual({ status: "upstream_outcome_unknown" });
    expect(h.gmail.messages.get("m0")?.labelIds).toEqual(["TRASH"]);
    expect(counted(h)).toEqual([{ action: "email.remove", items: 3 }]);
  });

  it("trash_thread counts the thread's messages", async () => {
    const h = setUp();
    expect(await h.call("trash_thread", { thread_id: "t1" })).toMatchObject({ status: "allowed" });
    expect(counted(h)).toEqual([{ action: "email.remove", items: 3 }]);
  });

  it("I-42: denies a whole batch that holds a hidden id, the same as a missing one", async () => {
    const h = setUp(`${ORGANIZE}${FAMILY}`);
    const hidden = await h.call("trash", { message_ids: ["m0", "m4"] });
    const missing = await h.call("trash", { message_ids: ["m0", "nope"] });
    expect(hidden).toEqual({ status: "denied", reason: "not_available", rule: null });
    expect(missing).toEqual(hidden);
    expect(h.gmail.messages.get("m0")?.labelIds).toEqual(["INBOX"]);
  });
});

describe("modify_labels", () => {
  it("is email.label for an ordinary change, by label name", async () => {
    const h = setUp(`rules:
  - match: { action: email.label }
    then: allow
`);
    const result = await h.call("modify_labels", { message_ids: ["m0"], add: ["Family"] });
    expect(result).toMatchObject({ status: "allowed" });
    expect(h.gmail.messages.get("m0")?.labelIds).toEqual(["INBOX", "Label_1"]);
  });

  it("is email.remove when it adds TRASH, so a rule for labels doesn't cover it", async () => {
    const h = setUp(`rules:
  - match: { action: email.label }
    then: allow
`);
    expect(await h.call("modify_labels", { message_ids: ["m0"], add: ["TRASH"] })).toMatchObject({
      status: "denied",
    });
  });

  it("refuses a label name the mailbox doesn't have", async () => {
    const h = setUp();
    expect(await h.call("modify_labels", { message_ids: ["m0"], add: ["Nope"] })).toMatchObject({
      status: "denied",
      reason: "unsupported",
    });
  });
});

describe("create_filter", () => {
  const FILTERS = `rules:
  - match: { action: email.filter }
    then: allow
`;

  it("creates a labelling filter under a rule for email.filter", async () => {
    const h = setUp(FILTERS);
    const result = await h.call("create_filter", {
      criteria: { from: "news@example.com" },
      add_labels: ["Family"],
    });
    expect(result).toMatchObject({ status: "allowed" });
    expect(h.gmail.filters).toMatchObject([
      { criteria: { from: "news@example.com" }, action: { addLabelIds: ["Label_1"] } },
    ]);
  });

  it("I-70: a forwarding filter needs a rule that names it; a broad allow isn't enough", async () => {
    const broad = setUp(`rules:
  - match: { kind: write }
    then: allow
`);
    const forward = { criteria: { from: "bank@example.com" }, forward_to: "me@elsewhere.com" };
    expect(await broad.call("create_filter", forward)).toEqual({
      status: "denied",
      reason: "persistence_unnamed",
      rule: null,
    });
    expect(broad.gmail.filters).toEqual([]);

    const named = setUp(`rules:
  - match: { tool: create_filter, recipients: { all_domain_in: [elsewhere.com] } }
    then: allow
`);
    expect(await named.call("create_filter", forward)).toMatchObject({ status: "allowed" });
    expect(named.gmail.filters).toMatchObject([{ action: { forward: "me@elsewhere.com" } }]);
  });

  it("a forwarding filter is email.send, so an org send deny stops it", async () => {
    const h = setUp(
      `rules:
  - match: { tool: create_filter }
    then: allow
`,
      `rules:
  - match: { action: email.send, recipients: { any_domain_in: [elsewhere.com] } }
    then: deny
`,
    );
    const result = await h.call("create_filter", {
      criteria: { from: "bank@example.com" },
      forward_to: "me@elsewhere.com",
    });
    expect(result).toMatchObject({ status: "denied" });
    expect(h.gmail.filters).toEqual([]);
  });
});
