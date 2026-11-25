import { describe, expect, it } from "vitest";
import {
  CalendarError,
  GoogleCalendarClient,
} from "../../src/definitions/calendar/google-client.ts";
import { GmailClient, GmailError } from "../../src/definitions/gmail/client.ts";
import { OutlookClient, OutlookError } from "../../src/definitions/outlook/client.ts";
import type { FetchFn } from "../../src/definitions/sign-in.ts";
import { NotFoundError } from "../../src/definitions/tool-table.ts";
import { UpstreamError } from "../../src/gateway/pipeline/ports.ts";

/**
 * How the Gmail, Outlook and Google Calendar clients treat an upstream's
 * status. A GET is sent at most twice: again only after a 429 or a 5xx, and
 * the second answer is the one that counts. A write is sent once. A 5xx or a
 * 408 on a write leaves the outcome unknown (a plain Error); any other
 * non-2xx is an UpstreamError, which heel reports as "nothing
 * happened". Which of the two a write gets decides what the approver and the
 * audit log see, so each provider is pinned here.
 */

const signal = new AbortController().signal;

type Answer = number | { status: number; text: string };

/** A fetch that gives `answers` in order and records each request and token. */
function upstream(answers: Answer[]) {
  const requests: { url: string; headers: Record<string, string> }[] = [];
  let tokens = 0;
  const fetch: FetchFn = async (input, init) => {
    const answer = answers[requests.length];
    requests.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    if (answer === undefined) throw new Error("an extra request");
    const { status, text } =
      typeof answer === "number"
        ? { status: answer, text: JSON.stringify({ status: answer }) }
        : answer;
    const empty = status === 204 || status === 304;
    return new Response(empty ? null : text, {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  const token = async () => `token-${++tokens}`;
  return { fetch, token, requests, tokens: () => tokens };
}

type Upstream = ReturnType<typeof upstream>;
type ErrorClass = new (...args: never[]) => Error;

interface Provider {
  name: string;
  /** How the unknown-outcome error names the upstream. */
  service: string;
  /** A GET whose 200 answer parses to `readResult`. */
  read: (u: Upstream) => Promise<unknown>;
  okBody: unknown;
  readResult: unknown;
  /** A write that resolves on a 204. */
  write: (u: Upstream) => Promise<unknown>;
  Failed: ErrorClass;
}

const PROVIDERS: Provider[] = [
  {
    name: "Gmail",
    service: "Gmail",
    read: (u) => new GmailClient(u.fetch, u.token).listLabels(signal),
    okBody: { labels: [{ id: "INBOX", name: "INBOX" }] },
    readResult: [{ id: "INBOX", name: "INBOX" }],
    write: (u) => new GmailClient(u.fetch, u.token).trashMessage("m1", signal),
    Failed: GmailError,
  },
  {
    name: "Outlook",
    service: "Graph",
    read: (u) => new OutlookClient(u.fetch, u.token).listRules(signal),
    okBody: { value: [{ id: "r1", displayName: "Rule" }] },
    readResult: [{ id: "r1", displayName: "Rule" }],
    write: (u) => new OutlookClient(u.fetch, u.token).deleteMessage("m1", signal),
    Failed: OutlookError,
  },
  {
    name: "Google Calendar",
    service: "Google Calendar",
    read: (u) => new GoogleCalendarClient(u.fetch, u.token).listCalendars(signal),
    okBody: { items: [{ id: "primary" }] },
    readResult: [{ id: "primary" }],
    write: (u) =>
      new GoogleCalendarClient(u.fetch, u.token).deleteEvent("primary", "e1", "none", signal),
    Failed: CalendarError,
  },
];

const ok = (body: unknown): Answer => ({ status: 200, text: JSON.stringify(body) });

async function failure(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (!(error instanceof Error)) throw new Error("expected the call to fail");
  return error;
}

describe.each(PROVIDERS)("$name", (p) => {
  describe("a GET", () => {
    it.each([429, 500, 503])("is sent once more after a %i, with a fresh token", async (status) => {
      const u = upstream([status, ok(p.okBody)]);
      expect(await p.read(u)).toEqual(p.readResult);
      expect(u.requests).toHaveLength(2);
      expect(u.tokens()).toBe(2);
      expect(u.requests[1]?.headers["authorization"]).toBe("Bearer token-2");
    });

    it.each([
      [429, 429],
      [503, 503],
      [500, 429],
    ])("is sent at most twice: %i then %i fails", async (first, second) => {
      const u = upstream([first, second, ok(p.okBody)]);
      expect(await failure(p.read(u))).toBeInstanceOf(p.Failed);
      expect(u.requests).toHaveLength(2);
    });

    it("is decided by the second answer after a retry", async () => {
      const u = upstream([500, 404]);
      expect(await failure(p.read(u))).toBeInstanceOf(NotFoundError);
      expect(u.requests).toHaveLength(2);
    });

    it.each([400, 401, 403, 408])("is sent once when answered %i", async (status) => {
      const u = upstream([status, ok(p.okBody)]);
      const error = await failure(p.read(u));
      expect(error).toBeInstanceOf(p.Failed);
      expect(error).not.toBeInstanceOf(NotFoundError);
      expect(u.requests).toHaveLength(1);
    });

    it("is NotFound on a 404, sent once", async () => {
      const u = upstream([404, ok(p.okBody)]);
      expect(await failure(p.read(u))).toBeInstanceOf(NotFoundError);
      expect(u.requests).toHaveLength(1);
    });

    it("is not retried when the fetch itself fails", async () => {
      let calls = 0;
      const u = upstream([]);
      const dropped = new TypeError("fetch failed");
      const fetch: FetchFn = async () => {
        calls++;
        throw dropped;
      };
      expect(await failure(p.read({ ...u, fetch }))).toBe(dropped);
      expect(calls).toBe(1);
    });
  });

  describe("a write", () => {
    it.each([500, 502, 503, 504, 408])(
      "answered %i is an unknown outcome, never a refusal, and is sent once",
      async (status) => {
        const u = upstream([status, 204]);
        const error = await failure(p.write(u));
        expect(error).not.toBeInstanceOf(UpstreamError);
        expect(error.constructor).toBe(Error);
        expect(error.message).toBe(`${p.service} answered ${status}; the write may have happened`);
        expect(u.requests).toHaveLength(1);
      },
    );

    it.each([400, 403, 404, 409, 410, 429])(
      "answered %i is refused with its status and body, and is sent once",
      async (status) => {
        const u = upstream([status, 204]);
        const error = await failure(p.write(u));
        expect(error).toBeInstanceOf(UpstreamError);
        expect(error).toMatchObject({ status, body: { status } });
        expect(u.requests).toHaveLength(1);
      },
    );

    it("answered with any other non-2xx, such as a 304, is refused", async () => {
      const u = upstream([304]);
      const error = await failure(p.write(u));
      expect(error).toBeInstanceOf(UpstreamError);
      expect(error).toMatchObject({ status: 304, body: null });
    });

    it("refused with a body that isn't JSON carries a null body", async () => {
      const u = upstream([{ status: 403, text: "<html>Forbidden</html>" }]);
      expect(await failure(p.write(u))).toMatchObject({ status: 403, body: null });
    });

    it("answered 204 succeeds", async () => {
      const u = upstream([204]);
      await expect(p.write(u)).resolves.toBeUndefined();
      expect(u.requests).toHaveLength(1);
    });
  });
});

describe("where the providers differ", () => {
  it("a GET answered 410 is NotFound for Google Calendar only", async () => {
    const calendar = upstream([410]);
    const deleted = await failure(
      new GoogleCalendarClient(calendar.fetch, calendar.token).getEvent("primary", "e1", signal),
    );
    expect(deleted).toBeInstanceOf(NotFoundError);

    const gmail = upstream([410]);
    const gmailError = await failure(new GmailClient(gmail.fetch, gmail.token).listLabels(signal));
    expect(gmailError).toBeInstanceOf(GmailError);
    expect(gmailError).not.toBeInstanceOf(NotFoundError);

    const outlook = upstream([410]);
    const outlookError = await failure(
      new OutlookClient(outlook.fetch, outlook.token).listRules(signal),
    );
    expect(outlookError).toBeInstanceOf(OutlookError);
    expect(outlookError).not.toBeInstanceOf(NotFoundError);
  });

  it("GmailError carries the status of the answer that decided the GET", async () => {
    const retried = upstream([503, 502]);
    expect(
      await failure(new GmailClient(retried.fetch, retried.token).listLabels(signal)),
    ).toMatchObject({ status: 502 });

    const once = upstream([400]);
    expect(await failure(new GmailClient(once.fetch, once.token).listLabels(signal))).toMatchObject(
      { status: 400 },
    );
  });

  it("Outlook sends no request, and asks for no token, for a link off this mailbox", async () => {
    const u = upstream([ok({ value: [] })]);
    const error = await failure(
      new OutlookClient(u.fetch, u.token).listMessages(
        { nextLink: "https://evil.example/v1.0/me/messages" },
        signal,
      ),
    );
    expect(error).toBeInstanceOf(OutlookError);
    expect(u.requests).toHaveLength(0);
    expect(u.tokens()).toBe(0);
  });

  it("Outlook asks for immutable ids and text bodies on every attempt, MIME reads included", async () => {
    const u = upstream([503, { status: 200, text: "MIME-Version: 1.0\r\n\r\nhi" }]);
    const mime = await new OutlookClient(u.fetch, u.token).getMime("m1", signal);
    expect(mime.toString()).toBe("MIME-Version: 1.0\r\n\r\nhi");
    expect(u.requests).toHaveLength(2);
    for (const request of u.requests) {
      expect(request.headers["prefer"]).toBe(
        'IdType="ImmutableId", outlook.body-content-type="text"',
      );
    }
  });
});
