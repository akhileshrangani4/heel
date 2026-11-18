import { describe, expect, it } from "vitest";
import { gmailRest } from "../../src/definitions/http/rest.ts";
import { readPlainMessage } from "../../src/definitions/mail/raw-read.ts";
import { createAgentApp } from "../../src/gateway/app.ts";
import { gmailPipeline } from "../helpers/gmail-pipeline.ts";

/**
 * Gmail's REST paths through the HTTP proxy (D7b): each becomes heel's own
 * Gmail tool, with the same rules, recipients and checks as over MCP.
 */

const raw = (text: string) => Buffer.from(text.replaceAll("\n", "\r\n")).toString("base64url");

const PLAIN = `From: alice@company.com
To: bob@partner.example
Cc: carol@partner.example
Subject: =?UTF-8?B?UTMgcGxhbiDinIU=?=
Content-Type: text/plain; charset=utf-8

See you Thursday.
`;

const ALTERNATIVE = `From: alice@company.com
To: bob@partner.example
Subject: Plan
MIME-Version: 1.0
Content-Type: multipart/alternative; boundary="b1"

--b1
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

caf=C3=A9 at 9
--b1
Content-Type: text/html; charset=utf-8

<p>café at 9</p>
--b1--
`;

describe("reading a raw message", () => {
  it("reads plain text, with an encoded subject", () => {
    expect(readPlainMessage(Buffer.from(PLAIN.replaceAll("\n", "\r\n")))).toEqual({
      from: "alice@company.com",
      to: ["bob@partner.example"],
      cc: ["carol@partner.example"],
      bcc: [],
      subject: "Q3 plan ✅",
      body: "See you Thursday.\r\n",
    });
  });

  it("reads text and HTML alternatives", () => {
    const message = readPlainMessage(Buffer.from(ALTERNATIVE.replaceAll("\n", "\r\n")));
    expect(message?.body).toBe("café at 9");
    expect(message?.html).toBe("<p>café at 9</p>");
  });

  it.each([
    ["an attachment", ALTERNATIVE.replace("multipart/alternative", "multipart/mixed")],
    ["a latin-1 body", PLAIN.replace("charset=utf-8", "charset=iso-8859-1")],
    ["a threading header", PLAIN.replace("Subject:", "In-Reply-To: <x@y>\nSubject:")],
    ["a Resent-To", PLAIN.replace("Subject:", "Resent-To: eve@evil.example\nSubject:")],
    ["two To headers", PLAIN.replace("Cc:", "To: eve@evil.example\nCc:")],
    ["a quoted local part", PLAIN.replace("bob@partner.example", '"bob@evil"@partner.example')],
    [
      "an unknown transfer encoding",
      PLAIN.replace("Content-Type:", "Content-Transfer-Encoding: x-uuencode\nContent-Type:"),
    ],
    ["an unclosed multipart", ALTERNATIVE.replace("--b1--", "")],
    [
      "a part with its own disposition",
      ALTERNATIVE.replace(
        "Content-Type: text/html",
        "Content-Disposition: attachment\nContent-Type: text/html",
      ),
    ],
  ])("refuses %s", (_label, text) => {
    expect(readPlainMessage(Buffer.from(text.replaceAll("\n", "\r\n")))).toBeNull();
  });
});

describe("the Gmail REST map", () => {
  it("maps reads to heel's tools", () => {
    expect(
      gmailRest({
        method: "GET",
        path: "/gmail/v1/users/me/messages",
        query: { q: "from:x", maxResults: "5" },
      }),
    ).toEqual({
      tool: "search",
      args: { query: "from:x", max_results: 5 },
    });
    expect(
      gmailRest({ method: "GET", path: "/gmail/v1/users/me/messages/abc", query: {} }),
    ).toEqual({
      tool: "get_message",
      args: { message_id: "abc" },
    });
  });

  it.each([
    [
      "another user's mailbox",
      { method: "GET", path: "/gmail/v1/users/bob@x.example/messages", query: {} },
    ],
    ["an unmapped path", { method: "DELETE", path: "/gmail/v1/users/me/messages/abc", query: {} }],
    [
      "an unknown query key",
      { method: "GET", path: "/gmail/v1/users/me/messages", query: { format: "raw" } },
    ],
    [
      "a send with a threadId",
      {
        method: "POST",
        path: "/gmail/v1/users/me/messages/send",
        query: {},
        json: { raw: raw(PLAIN), threadId: "t1" },
      },
    ],
  ])("refuses %s", (_label, request) => {
    expect(gmailRest(request)).toBeNull();
  });
});

describe("Gmail over the HTTP proxy", () => {
  function setUp(owner: string) {
    const h = gmailPipeline({ owner });
    const app = createAgentApp({
      db: h.t.db,
      log: h.logger,
      http: { db: h.t.db, pipeline: h.pipeline, log: h.logger },
    });
    const request = (path: string, init: RequestInit = {}) =>
      app.request(new URL(path, "http://localhost"), {
        ...init,
        headers: {
          authorization: `Bearer ${h.token}`,
          ...(init.headers as Record<string, string>),
        },
      });
    return { ...h, request };
  }

  const send = (body: unknown) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  it("sends a raw message as heel's own send, with recipients from its headers", async () => {
    const h = setUp(`rules:
  - match: { action: email.send, recipients: { all_domain_in: [partner.example] } }
    then: allow
`);
    const response = await h.request(
      "/http/gmail-work/gmail/v1/users/me/messages/send",
      send({ raw: raw(PLAIN) }),
    );
    expect(response.status).toBe(200);
    expect(h.gmail.sent).toHaveLength(1);
    expect(h.gmail.sent[0]?.headers["to"]).toContain("bob@partner.example");
  });

  it("asks when a recipient is outside the rule, like any other send", async () => {
    const h = setUp(`rules:
  - match: { action: email.send, recipients: { all_domain_in: [company.com] } }
    then: allow
  - match: { action: email.send }
    then: ask
`);
    const response = await h.request(
      "/http/gmail-work/gmail/v1/users/me/messages/send",
      send({ raw: raw(PLAIN) }),
    );
    expect(response.status).toBe(202);
    expect(h.gmail.sent).toEqual([]);
  });

  it("refuses a message heel can't read plainly before any rule", async () => {
    const h = setUp("rules:\n  - match: { action: email.send }\n    then: allow\n");
    const latin = raw(PLAIN.replace("charset=utf-8", "charset=iso-8859-1"));
    const response = await h.request(
      "/http/gmail-work/gmail/v1/users/me/messages/send",
      send({ raw: latin }),
    );
    expect(response.status).toBe(403);
    expect(h.gmail.sent).toEqual([]);
  });

  it("refuses a sender the mailbox can't send as", async () => {
    const h = setUp("rules:\n  - match: { action: email.send }\n    then: allow\n");
    const spoofed = raw(PLAIN.replace("alice@company.com", "ceo@company.com"));
    const response = await h.request(
      "/http/gmail-work/gmail/v1/users/me/messages/send",
      send({ raw: spoofed }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ reason: "sender_not_allowed" });
    expect(h.gmail.sent).toEqual([]);
  });
});
