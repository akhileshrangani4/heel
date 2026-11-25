import { CALENDAR_API_BASE } from "../../src/definitions/google/oauth.ts";

/** A fake Google Calendar v3 behind `fetch`, shaped like the answers heel reads. */

export const CALENDAR_TEST_TOKEN = "calendar-test-access";
export const OWNER_CALENDAR = "alice@company.com";

export interface FakeEvent {
  id: string;
  calendar: string;
  summary?: string;
  attendees?: string[];
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
}

export class FakeCalendar {
  readonly events = new Map<string, FakeEvent>();
  /** Each write, with its `sendUpdates`. */
  readonly writes: { method: string; path: string; sendUpdates: string | null; body: unknown }[] =
    [];
  /** Answers every write in place of the calendar, e.g. with a refusal. */
  writeAnswer: (() => Response) | null = null;
  #next = 1;

  add(...events: FakeEvent[]): this {
    for (const e of events) this.events.set(e.id, { ...e });
    return this;
  }

  #serve(e: FakeEvent) {
    return {
      id: e.id,
      status: "confirmed",
      summary: e.summary,
      start: e.start ?? { dateTime: "2026-11-20T10:00:00Z" },
      end: e.end ?? { dateTime: "2026-11-20T11:00:00Z" },
      attendees: (e.attendees ?? []).map((email) => ({ email })),
      organizer: { email: OWNER_CALENDAR, self: true },
    };
  }

  readonly fetch = async (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input.toString());
    if (!url.toString().startsWith(CALENDAR_API_BASE)) return Response.json({}, { status: 404 });
    if (new Headers(init?.headers).get("authorization") !== `Bearer ${CALENDAR_TEST_TOKEN}`) {
      return Response.json({}, { status: 401 });
    }
    const path = url.pathname.replace(new URL(CALENDAR_API_BASE).pathname, "");
    const method = init?.method ?? "GET";
    if (path === "users/me/calendarList") {
      return Response.json({
        items: [{ id: OWNER_CALENDAR, summary: "Alice", primary: true, accessRole: "owner" }],
      });
    }
    const match = /^calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
    if (match === null) return Response.json({}, { status: 404 });
    const calendar = decodeURIComponent(match[1] ?? "");
    const resolved = calendar === "primary" ? OWNER_CALENDAR : calendar;
    const id = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
    if (method !== "GET") {
      const body = init?.body === undefined ? null : JSON.parse(String(init.body));
      this.writes.push({ method, path, sendUpdates: url.searchParams.get("sendUpdates"), body });
      if (this.writeAnswer !== null) return this.writeAnswer();
    }
    if (id === undefined) {
      if (method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          summary: string;
          attendees: { email: string }[];
        };
        const e: FakeEvent = {
          id: `ev${this.#next++}`,
          calendar: resolved,
          summary: body.summary,
          attendees: body.attendees.map((a) => a.email),
        };
        this.events.set(e.id, e);
        return Response.json(this.#serve(e));
      }
      return Response.json({
        items: [...this.events.values()]
          .filter((e) => e.calendar === resolved)
          .map((e) => this.#serve(e)),
      });
    }
    const e = this.events.get(id);
    if (e === undefined || e.calendar !== resolved) return Response.json({}, { status: 404 });
    if (method === "DELETE") {
      this.events.delete(id);
      return new Response(null, { status: 204 });
    }
    if (method === "PATCH") {
      const body = JSON.parse(String(init?.body)) as {
        summary?: string;
        attendees?: { email: string }[];
      };
      if (body.summary !== undefined) e.summary = body.summary;
      if (body.attendees !== undefined) e.attendees = body.attendees.map((a) => a.email);
      return Response.json(this.#serve(e));
    }
    return Response.json(this.#serve(e));
  };
}
