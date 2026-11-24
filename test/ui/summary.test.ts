import { describe, expect, it } from "vitest";
import {
  argumentLines,
  emailPreviewFrom,
  groupByDomain,
  homeDomain,
  httpPreviewFrom,
  mailPreviewFrom,
  mergePreviewFrom,
  middle,
  recipientPhrase,
} from "../../src/web/ui/summary.ts";

const SEND = {
  from: "alice@company.com",
  to: ["bob@vendor.com"],
  cc: ["carol@company.com"],
  bcc: [],
  subject: "Q4",
  body: "Hi Bob",
};

describe("homeDomain", () => {
  it("is the sender's domain, or null for a public mail provider", () => {
    expect(homeDomain("alice@company.com")).toBe("company.com");
    expect(homeDomain("alice@gmail.com")).toBeNull();
  });
});

describe("groupByDomain", () => {
  it("keeps every address once, in order, and marks other domains as outside", () => {
    expect(
      groupByDomain(["a@x.com", "b@company.com", "c@x.com", "a@x.com"], "company.com"),
    ).toEqual([
      { domain: "x.com", addresses: ["a@x.com", "c@x.com"], outside: true },
      { domain: "company.com", addresses: ["b@company.com"], outside: false },
    ]);
  });

  it("marks nobody outside when the sender's organization is unknown", () => {
    expect(groupByDomain(["a@x.com"], null)).toEqual([
      { domain: "x.com", addresses: ["a@x.com"], outside: false },
    ]);
  });
});

describe("emailPreviewFrom", () => {
  it("reads a normalized send", () => {
    expect(emailPreviewFrom("email.send", SEND)).toMatchObject({
      from: "alice@company.com",
      to: ["bob@vendor.com"],
      cc: ["carol@company.com"],
      bodyFormat: "text",
    });
  });

  it("shows an HTML-only body as its source", () => {
    expect(emailPreviewFrom("email.send", { ...SEND, body: "", html: "<p>Hi</p>" })).toMatchObject({
      body: "<p>Hi</p>",
      bodyFormat: "html",
    });
  });

  it("carries a forward's original text and attachment names", () => {
    const preview = emailPreviewFrom("email.send", {
      ...SEND,
      forwarded_text: "original",
      forwarded_attachments: ["a.pdf"],
    });
    expect(preview?.forwarded).toEqual({ text: "original", attachments: ["a.pdf"] });
  });

  it("is null for another action or an unexpected shape, never a guess", () => {
    expect(emailPreviewFrom("email.draft", SEND)).toBeNull();
    expect(emailPreviewFrom("email.send", { ...SEND, to: "bob@vendor.com" })).toBeNull();
    expect(emailPreviewFrom("email.send", null)).toBeNull();
  });
});

describe("recipientPhrase", () => {
  const email = (to: string[], cc: string[] = []) => {
    const preview = emailPreviewFrom("email.send", { ...SEND, to, cc });
    if (preview === null) throw new Error("no preview");
    return preview;
  };

  it("names a single recipient", () => {
    expect(recipientPhrase(email(["bob@vendor.com"]))).toBe("bob@vendor.com");
  });

  it("counts the rest by domain", () => {
    expect(recipientPhrase(email(["bob@vendor.com"], ["c@vendor.com", "d@vendor.com"]))).toBe(
      "bob@vendor.com and 2 others at vendor.com",
    );
    expect(recipientPhrase(email(["bob@vendor.com"], ["c@other.com"]))).toBe(
      "bob@vendor.com and 1 other at 2 domains",
    );
  });
});

describe("mergePreviewFrom", () => {
  it("reads a normalized merge, workflow merges included", () => {
    const args = { repo: "acme/web", number: 7, method: "squash", sha: "abc", base: "main" };
    expect(mergePreviewFrom("github.merge", args)).toEqual(args);
    expect(mergePreviewFrom("github.workflow.merge", args)).toEqual(args);
    expect(mergePreviewFrom("github.push", args)).toBeNull();
  });
});

describe("argumentLines", () => {
  it("lists top-level arguments sorted by name, with full values", () => {
    const long = "x".repeat(500);
    expect(argumentLines({ b: 2, a: ["x", "y"], c: long, d: { n: 1 } })).toEqual([
      { name: "a", value: "x, y", block: false },
      { name: "b", value: "2", block: false },
      { name: "c", value: long, block: true },
      { name: "d", value: '{\n  "n": 1\n}', block: true },
    ]);
  });

  it("puts who or what the call reaches first, then its content, and marks empty values", () => {
    const lines = argumentLines({
      bcc: [],
      body: "Hi",
      cc: null,
      from: "a@b.c",
      priority: 2,
      subject: "Q4",
      to: ["bob@vendor.com"],
      labels: {},
      project: "",
    });
    expect(lines.map((l) => l.name)).toEqual([
      "to",
      "subject",
      "body",
      "bcc",
      "cc",
      "from",
      "labels",
      "priority",
      "project",
    ]);
    expect(lines.filter((l) => l.empty).map((l) => l.name)).toEqual([
      "bcc",
      "cc",
      "labels",
      "project",
    ]);
  });
});

describe("mailPreviewFrom", () => {
  it("reads a draft as the email it holds; the list's emailPreviewFrom still doesn't", () => {
    expect(mailPreviewFrom("email.draft", SEND)).toMatchObject({ to: ["bob@vendor.com"] });
    expect(mailPreviewFrom("email.draft", { draft_id: "r-1" })).toBeNull();
    expect(emailPreviewFrom("email.draft", SEND)).toBeNull();
  });
});

describe("middle", () => {
  it("cuts a long value in the middle for a title, and leaves a short one alone", () => {
    expect(middle("bob@vendor.com")).toBe("bob@vendor.com");
    const cut = middle("eve.long-surname-for-wrapping@a-very-long-partner-domain.example", 24);
    expect(cut).toHaveLength(24);
    expect(cut).toBe("eve.long-sur…ain.example");
  });
});

describe("httpPreviewFrom", () => {
  const b64 = (text: string) => Buffer.from(text).toString("base64");
  const call = (args: Record<string, unknown>, body?: unknown) => ({
    surface: "http",
    args,
    http: { method: "PUT", path: "/items/5", query: {}, ...(body === undefined ? {} : { body }) },
  });

  it("shows a parsed body as JSON, not the base64 the call carries", () => {
    const sent = { transfer_to: "attacker@evil.example", amount: 99999 };
    const preview = httpPreviewFrom(
      call({ body: b64(JSON.stringify(sent)), contentType: "application/json" }, sent),
    );
    expect(preview?.body).toEqual({ kind: "json", text: JSON.stringify(sent, null, 2) });
  });

  it("decodes an unparsed text body, and only describes bytes that aren't text", () => {
    expect(httpPreviewFrom(call({ body: b64("hello"), contentType: "text/plain" }))?.body).toEqual({
      kind: "text",
      text: "hello",
      contentType: "text/plain",
    });
    const binary = Buffer.from([0xff, 0xfe, 0x00]).toString("base64");
    expect(httpPreviewFrom(call({ body: binary, contentType: "image/png" }))?.body).toEqual({
      kind: "bytes",
      size: 3,
      contentType: "image/png",
    });
  });

  it("is null for calls that didn't come through the HTTP proxy", () => {
    expect(httpPreviewFrom({ ...call({}), surface: "mcp" })).toBeNull();
  });
});
