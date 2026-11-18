import { describe, expect, it } from "vitest";
import type { FakeMessage } from "../../helpers/fake-gmail.ts";
import { gmailPipeline } from "../../helpers/gmail-pipeline.ts";

/**
 * Gmail's sending tools (D9a-2) through the real pipeline, against a fake
 * mailbox that records the exact bytes heel posts. Each test checks both
 * what rules saw and what Gmail was asked to send.
 */

const SENDS = `rules:
  - match: { kind: read }
    then: allow
  - match: { action: email.send }
    then: allow
  - match: { action: email.draft }
    then: allow
`;

const ALICE = "alice@company.com";

/** A thread Alice started with Bob and Carol; Dave only ever wrote in. */
const THREAD: FakeMessage[] = [
  {
    id: "t1-a",
    threadId: "t1",
    from: `Alice <${ALICE}>`,
    to: "bob@company.com",
    cc: "carol@company.com",
    subject: "Plan",
    labelIds: ["SENT"],
    messageId: "<a@mail.company.com>",
    text: "Here's the plan",
  },
  {
    id: "t1-b",
    threadId: "t1",
    from: "Bob <bob@company.com>",
    to: ALICE,
    cc: "carol@company.com, dave@vendor.com",
    replyTo: "bob-replies@company.com",
    subject: "Re: Plan",
    messageId: "<b@mail.company.com>",
    references: "<a@mail.company.com>",
    text: "Looks good",
  },
  {
    id: "t2-a",
    threadId: "t2",
    from: "Dave <dave@vendor.com>",
    to: ALICE,
    subject: "Quote",
    messageId: "<d@vendor.com>",
    text: "Our quote",
  },
];

function setUp(owner = SENDS) {
  const h = gmailPipeline({ owner });
  h.gmail.add(...THREAD);
  return h;
}

const MESSAGE = {
  from: ALICE,
  to: ["Bob <Bob@Company.com>"],
  subject: "Hi",
  body: "Hello",
};

describe("send", () => {
  it("I-19: sends to exactly the recipients rules saw, Bcc included", async () => {
    const { call, gmail } = setUp();
    const result = await call("send", {
      ...MESSAGE,
      cc: ["carol@company.com"],
      bcc: ["x@else.com"],
    });
    expect(result).toMatchObject({ status: "allowed", result: { id: expect.any(String) } });
    expect(gmail.sent).toHaveLength(1);
    const headers = gmail.sent[0]?.headers ?? {};
    expect(headers["from"]).toBe(ALICE);
    expect(headers["to"]).toBe("bob@company.com");
    expect(headers["cc"]).toBe("carol@company.com");
    expect(headers["bcc"]).toBe("x@else.com");
  });

  it("I-19: a Bcc-only client address trips any_domain_in", async () => {
    const { call, gmail } = setUp(`rules:
  - match: { action: email.send, recipients: { any_domain_in: [clientco.com] } }
    then: deny
${SENDS.replace("rules:\n", "")}`);
    const result = await call("send", { ...MESSAGE, bcc: ["ceo@clientco.com"] });
    expect(result).toMatchObject({ status: "denied" });
    expect(gmail.sent).toEqual([]);
  });

  it("refuses a from the mailbox can't send as, including an unverified alias", async () => {
    const { call, gmail } = setUp();
    for (const from of ["someone@company.com", "pending@alias.example"]) {
      expect(await call("send", { ...MESSAGE, from })).toEqual({
        status: "denied",
        reason: "sender_not_allowed",
        rule: null,
      });
    }
    expect(await call("send", { ...MESSAGE, from: "alice@alias.example" })).toMatchObject({
      status: "allowed",
    });
    expect(gmail.sent).toHaveLength(1);
  });

  it("refuses a subject that would add a header", async () => {
    const { call, gmail } = setUp();
    const result = await call("send", { ...MESSAGE, subject: "Hi\r\nBcc: evil@else.com" });
    expect(result).toMatchObject({ status: "denied", reason: "unsupported" });
    expect(gmail.sent).toEqual([]);
  });

  it("reports Gmail refusing the send, and never retries a send", async () => {
    const refused = setUp();
    refused.gmail.sendBehavior = "refuse";
    expect(await refused.call("send", MESSAGE)).toMatchObject({
      status: "upstream_error",
      upstreamStatus: 400,
    });

    const dropped = setUp();
    dropped.gmail.sendBehavior = "drop";
    expect(await dropped.call("send", MESSAGE)).toEqual({ status: "upstream_outcome_unknown" });
    expect(dropped.gmail.requests.filter((r) => r.startsWith("POST"))).toHaveLength(1);
  });
});

describe("reply and reply_all", () => {
  it("I-19: reply goes to Reply-To, in the thread, with the threading headers", async () => {
    const { call, gmail } = setUp();
    const result = await call("reply", { message_id: "t1-b", from: ALICE, body: "Thanks" });
    expect(result).toMatchObject({ status: "allowed" });
    const sent = gmail.sent[0];
    expect(sent?.threadId).toBe("t1");
    expect(sent?.headers["to"]).toBe("bob-replies@company.com");
    expect(sent?.headers["subject"]).toBe("Re: Plan");
    expect(sent?.headers["in-reply-to"]).toBe("<b@mail.company.com>");
    expect(sent?.headers["references"]).toBe("<a@mail.company.com> <b@mail.company.com>");
  });

  it("reply_all adds the original To and Cc, minus the mailbox's own addresses", async () => {
    const { call, gmail } = setUp();
    await call("reply_all", { message_id: "t1-b", from: ALICE, body: "Thanks all" });
    const headers = gmail.sent[0]?.headers ?? {};
    expect(headers["to"]).toBe("bob-replies@company.com");
    expect(headers["cc"]).toBe("carol@company.com, dave@vendor.com");
  });

  it("I-42: denies a reply to a hidden message, sending nothing", async () => {
    const { call, gmail } = setUp(
      `${SENDS}hide:\n  - email: { from: { any_of: [dave@vendor.com] } }\n`,
    );
    expect(await call("reply", { message_id: "t2-a", from: ALICE, body: "Hi" })).toEqual({
      status: "denied",
      reason: "not_available",
      rule: null,
    });
    expect(gmail.sent).toEqual([]);
  });
});

describe("all_in_thread", () => {
  const OWNER = `rules:
  - match: { action: email.send, recipients: { all_in_thread: true } }
    then: allow
`;

  it("passes when every recipient was on a message the mailbox sent in the thread", async () => {
    const { call } = setUp(OWNER);
    const result = await call("reply", { message_id: "t1-a", from: ALICE, body: "Ping" });
    expect(result).toMatchObject({ status: "allowed" });
  });

  it("I-21: fails for someone who only wrote in", async () => {
    const { call, gmail } = setUp(OWNER);
    // Dave was cc'd by Bob, never by Alice.
    const result = await call("reply_all", { message_id: "t1-b", from: ALICE, body: "Hi" });
    expect(result).toMatchObject({ status: "denied" });
    expect(await call("reply", { message_id: "t2-a", from: ALICE, body: "Hi" })).toMatchObject({
      status: "denied",
    });
    expect(gmail.sent).toEqual([]);
  });

  it("I-21: fails for a new message, which has no thread", async () => {
    const { call } = setUp(OWNER);
    expect(await call("send", { ...MESSAGE, to: ["bob@company.com"] })).toMatchObject({
      status: "denied",
    });
  });
});

describe("forward", () => {
  it("attaches the original whole and sends to the named recipients", async () => {
    const { call, gmail } = setUp();
    const result = await call("forward", {
      message_id: "t2-a",
      from: ALICE,
      to: ["finance@company.com"],
      body: "FYI",
    });
    expect(result).toMatchObject({ status: "allowed" });
    const sent = gmail.sent[0];
    expect(sent?.headers["to"]).toBe("finance@company.com");
    expect(sent?.headers["subject"]).toBe("Fwd: Quote");
    expect(sent?.raw).toContain("message/rfc822");
    expect(sent?.raw).toContain("Our quote");
  });

  it("sends nothing when the original changed after heel checked it", async () => {
    const { call, gmail } = setUp();
    let reads = 0;
    gmail.afterRawRead = () => {
      reads += 1;
      if (reads === 2) gmail.add({ ...(THREAD[2] as FakeMessage), text: "Changed quote" });
    };
    const result = await call("forward", {
      message_id: "t2-a",
      from: ALICE,
      to: ["f@company.com"],
    });
    expect(result).toMatchObject({ status: "upstream_error", upstreamStatus: 409 });
    expect(gmail.sent).toEqual([]);
  });
});

describe("drafts", () => {
  it("are email.draft, so a rule on email.send doesn't cover them", async () => {
    const { call, gmail } = setUp(`rules:
  - match: { action: email.send }
    then: allow
`);
    expect(await call("create_draft", MESSAGE)).toMatchObject({ status: "denied" });
    expect(gmail.drafts.size).toBe(0);
  });

  it("create and update store the composed message; delete removes it", async () => {
    const { call, gmail } = setUp();
    const created = await call("create_draft", MESSAGE);
    const draftId = (created as { result: { draft_id: string } }).result.draft_id;
    expect(gmail.drafts.get(draftId)?.raw).toContain("Hello");
    await call("update_draft", { draft_id: draftId, ...MESSAGE, body: "Hello again" });
    expect(gmail.drafts.get(draftId)?.raw).toContain("Hello again");
    await call("delete_draft", { draft_id: draftId });
    expect(gmail.drafts.has(draftId)).toBe(false);
    expect(gmail.sent).toEqual([]);
  });
});

describe("send_draft", () => {
  const RAW = [
    `From: Alice <${ALICE}>`,
    "To: bob@company.com",
    "Bcc: ceo@clientco.com",
    "Subject: Numbers",
    "",
    "The numbers",
  ].join("\r\n");

  function withDraft(owner = SENDS) {
    const h = setUp(owner);
    h.gmail.drafts.set("d1", { id: "d1", threadId: "t9", raw: RAW });
    return h;
  }

  it("I-19: checks the draft's own headers, Bcc included", async () => {
    const { call, gmail } = withDraft(`rules:
  - match: { action: email.send, recipients: { any_domain_in: [clientco.com] } }
    then: deny
${SENDS.replace("rules:\n", "")}`);
    expect(await call("send_draft", { draft_id: "d1" })).toMatchObject({ status: "denied" });
    expect(gmail.sent).toEqual([]);
  });

  it("sends exactly the checked bytes, then deletes the draft", async () => {
    const { call, gmail } = withDraft();
    expect(await call("send_draft", { draft_id: "d1" })).toMatchObject({ status: "allowed" });
    expect(gmail.sent[0]?.raw).toBe(RAW);
    expect(gmail.sent[0]?.threadId).toBe("t9");
    expect(gmail.drafts.has("d1")).toBe(false);
  });

  it("sends nothing when the draft changed after heel checked it", async () => {
    const { call, gmail } = withDraft();
    let reads = 0;
    gmail.afterRawRead = () => {
      reads += 1;
      // The draft read, then the two pinning reads; change it after all three.
      if (reads === 3) {
        gmail.drafts.set("d1", { id: "d1", threadId: "t9", raw: RAW.replace("bob@", "eve@") });
      }
    };
    expect(await call("send_draft", { draft_id: "d1" })).toMatchObject({
      status: "upstream_error",
      upstreamStatus: 409,
    });
    expect(gmail.sent).toEqual([]);
  });

  it("still reports the send when deleting the draft fails", async () => {
    const { call, gmail } = withDraft();
    gmail.draftDeletes = false;
    expect(await call("send_draft", { draft_id: "d1" })).toMatchObject({ status: "allowed" });
    expect(gmail.sent).toHaveLength(1);
  });
});

describe("review findings: what rules check is where mail goes", () => {
  it("treats a quoted local part as the plain address it is", async () => {
    const { call, gmail } = setUp(`rules:
  - match: { action: email.send, recipients: { any_of: [ceo@company.com] } }
    then: deny
${SENDS.replace("rules:\n", "")}`);
    expect(await call("send", { ...MESSAGE, to: ['"ceo"@company.com'] })).toMatchObject({
      status: "denied",
    });
    expect(gmail.sent).toEqual([]);
  });

  it("refuses any other quoted local part outright", async () => {
    const { call, gmail } = setUp();
    const tricky = '"x>, attacker@evil.com, <y"@company.com';
    expect(await call("send", { ...MESSAGE, to: [tricky] })).toMatchObject({
      status: "denied",
      reason: "unsupported",
    });
    expect(gmail.sent).toEqual([]);
  });

  it("refuses a reply whose Reply-To can't be read plainly", async () => {
    const { call, gmail } = setUp();
    gmail.add({
      id: "q1",
      threadId: "tq",
      from: "Mallory <mallory@evil.com>",
      replyTo: '"x@evil.example, y"@company.com',
      to: ALICE,
      subject: "Hi",
      text: "Hi",
    });
    expect(await call("reply", { message_id: "q1", from: ALICE, body: "Hi" })).toEqual({
      status: "denied",
      reason: "address_unparseable",
      rule: null,
    });
    expect(gmail.sent).toEqual([]);
  });

  it("I-21: a forged From of your own address doesn't make a message yours", async () => {
    const { call, gmail } = setUp(`rules:
  - match: { action: email.send, recipients: { all_in_thread: true } }
    then: allow
`);
    gmail.add({
      id: "f1",
      threadId: "tf",
      from: `Alice <${ALICE}>`,
      to: "attacker@evil.com",
      subject: "Totally from Alice",
      labelIds: ["INBOX"],
      text: "Reply to me",
    });
    // Not SENT, so the reply goes to the forged From (Alice), not to its To.
    expect(await call("reply_all", { message_id: "f1", from: ALICE, body: "Hi" })).toMatchObject({
      status: "denied",
    });
    expect(gmail.sent).toEqual([]);
  });

  it("I-21: a draft doesn't vouch for its own recipients", async () => {
    const { call, gmail } = setUp(`rules:
  - match: { action: email.send, recipients: { all_in_thread: true } }
    then: allow
`);
    gmail.drafts.set("d2", {
      id: "d2",
      threadId: "t1",
      raw: [`From: ${ALICE}`, "To: attacker@evil.com", "Subject: Re: Plan", "", "Hi"].join("\r\n"),
    });
    expect(await call("send_draft", { draft_id: "d2" })).toMatchObject({ status: "denied" });
    expect(gmail.sent).toEqual([]);
  });

  it.each([
    ["two addresses in one mailbox", "To: Bob <attacker@evil.com> <bob@company.com>"],
    ["a Resent-Bcc header", "To: bob@company.com\r\nResent-Bcc: attacker@evil.com"],
    ["a bare CR hiding a header", "To: bob@company.com\r\nX-Foo: y\rBcc: attacker@evil.com"],
    ["a second To header", "To: bob@company.com\r\nTo: attacker@evil.com"],
  ])("refuses a draft with %s", async (_, header) => {
    const { call, gmail } = setUp();
    gmail.drafts.set("d3", {
      id: "d3",
      threadId: "t9",
      raw: [`From: ${ALICE}`, header, "Subject: x", "", "Body"].join("\r\n"),
    });
    expect(await call("send_draft", { draft_id: "d3" })).toEqual({
      status: "denied",
      reason: "address_unparseable",
      rule: null,
    });
    expect(gmail.sent).toEqual([]);
  });

  it("I-42: a hidden draft is refused like a missing one", async () => {
    const { call, gmail } = setUp(
      `${SENDS}hide:\n  - email: { subject: { matches: "(?i).*secret.*" } }\n`,
    );
    gmail.drafts.set("d4", {
      id: "d4",
      threadId: "t9",
      raw: [`From: ${ALICE}`, "To: bob@company.com", "Subject: Secret plan", "", "x"].join("\r\n"),
    });
    for (const tool of ["send_draft", "delete_draft"]) {
      expect(await call(tool, { draft_id: "d4" })).toEqual({
        status: "denied",
        reason: "not_available",
        rule: null,
      });
      expect(await call(tool, { draft_id: "nope" })).toEqual({
        status: "denied",
        reason: "not_available",
        rule: null,
      });
    }
    expect(gmail.drafts.has("d4")).toBe(true);
  });

  it("puts the text of a draft or forwarded message in the call the approver sees", async () => {
    const { call, gmail, t } = setUp(`rules:
  - match: { action: email.send }
    then: ask
`);
    gmail.drafts.set("d5", {
      id: "d5",
      threadId: "t9",
      raw: [`From: ${ALICE}`, "To: bob@company.com", "Subject: Numbers", "", "Wire it today"].join(
        "\r\n",
      ),
    });
    await call("send_draft", { draft_id: "d5" });
    await call("forward", { message_id: "t2-a", from: ALICE, to: ["f@company.com"] });
    const pending = t.store.sqlite
      .prepare("select call from approvals order by created_at")
      .all() as {
      call: string;
    }[];
    const args = pending.map(
      (row) => (JSON.parse(row.call) as { args: Record<string, unknown> }).args,
    );
    expect(args[0]?.["body"]).toContain("Wire it today");
    expect(args[1]?.["forwarded_text"]).toContain("Our quote");
  });

  it("drops the original's Bcc from a forwarded attachment", async () => {
    const { call, gmail } = setUp();
    gmail.add({
      id: "s1",
      threadId: "ts",
      from: ALICE,
      to: "bob@company.com",
      bcc: "secret-boss@company.com",
      subject: "Offer",
      labelIds: ["SENT"],
      text: "The offer",
    });
    await call("forward", { message_id: "s1", from: ALICE, to: ["f@company.com"] });
    expect(gmail.sent[0]?.raw).toContain("The offer");
    expect(gmail.sent[0]?.raw).not.toContain("secret-boss@company.com");
  });

  it("treats a 5xx on a send as an unknown outcome, never as not sent", async () => {
    const { call, gmail } = setUp();
    gmail.sendBehavior = "error500";
    expect(await call("send", MESSAGE)).toEqual({ status: "upstream_outcome_unknown" });
  });
});
