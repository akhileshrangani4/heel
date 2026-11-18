import { z } from "zod";
import { CALENDAR_API_BASE, type FetchFn } from "../google/oauth.ts";

/**
 * The Google Calendar API v3 calls heel needs. GETs retry once on 429 and
 * 5xx; writes are sent once and never retried.
 *
 * P-5, the reference each call was written against
 * (https://developers.google.com/workspace/calendar/api/v3/reference):
 * - events.list: `.../events/list`. singleEvents with orderBy=startTime;
 *   pages can be short while nextPageToken is set.
 * - events.get, events.insert, events.patch, events.delete: `.../events/<method>`.
 *   insert takes sendUpdates (all | externalOnly | none; default none) and
 *   "some emails might still be sent"; a patch's `attendees` replaces the
 *   whole list.
 * - calendarList.list: `.../calendarList/list` (needs the calendarlist scope;
 *   `calendar.events` doesn't reach it).
 * - Errors (`/workspace/calendar/api/guides/errors`): 404 for an id that never
 *   existed or isn't accessible, 410 for one already deleted.
 * heel offers no events.import, move or quickAdd, and no acl or watch calls.
 */

const AttendeeSchema = z.object({
  email: z.string().optional(),
  displayName: z.string().optional(),
  responseStatus: z.string().optional(),
  organizer: z.boolean().optional(),
  self: z.boolean().optional(),
  resource: z.boolean().optional(),
});

const WhenSchema = z.object({
  dateTime: z.string().optional(),
  date: z.string().optional(),
  timeZone: z.string().optional(),
});

export const EventSchema = z.object({
  id: z.string(),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: WhenSchema.optional(),
  end: WhenSchema.optional(),
  attendees: z.array(AttendeeSchema).default([]),
  organizer: z.object({ email: z.string().optional(), self: z.boolean().optional() }).optional(),
  htmlLink: z.string().optional(),
  recurrence: z.array(z.string()).optional(),
});
export type CalendarEvent = z.output<typeof EventSchema>;

const EventListSchema = z.object({
  items: z.array(EventSchema).default([]),
  nextPageToken: z.string().optional(),
});

const CalendarListSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.string(),
        summary: z.string().optional(),
        primary: z.boolean().optional(),
        accessRole: z.string().optional(),
      }),
    )
    .default([]),
});

export class CalendarNotFoundError extends Error {
  override readonly name = "CalendarNotFoundError";
}

export class CalendarError extends Error {
  override readonly name = "CalendarError";
}

/** Google refused a write: it didn't happen. */
export class CalendarWriteRefused extends Error {
  override readonly name = "CalendarWriteRefused";
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown) {
    super(`Google Calendar refused the write (${status})`);
    this.status = status;
    this.body = body;
  }
}

const RETRYABLE = (status: number) => status === 429 || status >= 500;

/** Who a write notifies (`sendUpdates`): everyone, or nobody. */
export type SendUpdates = "all" | "none";

export class GoogleCalendarClient {
  readonly #fetch: FetchFn;
  readonly #token: () => Promise<string>;

  constructor(fetch: FetchFn, token: () => Promise<string>) {
    this.#fetch = fetch;
    this.#token = token;
  }

  #url(path: string, query: Record<string, string | undefined> = {}): URL {
    const url = new URL(path, CALENDAR_API_BASE);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, value);
    }
    return url;
  }

  async #get<T>(url: URL, schema: z.ZodType<T>, signal: AbortSignal): Promise<T> {
    let response: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      response = await this.#fetch(url, {
        headers: { authorization: `Bearer ${await this.#token()}`, accept: "application/json" },
        signal,
      });
      if (!RETRYABLE(response.status)) break;
    }
    if (response === null) throw new CalendarError("no response");
    // 410: the event was deleted.
    if (response.status === 404 || response.status === 410) {
      throw new CalendarNotFoundError(`${url.pathname} was not found`);
    }
    if (!response.ok) throw new CalendarError(`Google Calendar answered ${response.status}`);
    const parsed = schema.safeParse(await response.json());
    if (!parsed.success) throw new CalendarError(`the answer to ${url.pathname} didn't parse`);
    return parsed.data;
  }

  async #write(method: "POST" | "PATCH" | "DELETE", url: URL, body: unknown, signal: AbortSignal) {
    const response = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${await this.#token()}`,
        accept: "application/json",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    });
    if (response.status >= 500 || response.status === 408) {
      throw new Error(`Google Calendar answered ${response.status}; the write may have happened`);
    }
    if (!response.ok) {
      throw new CalendarWriteRefused(response.status, await response.json().catch(() => null));
    }
    return response.status === 204 ? null : await response.json().catch(() => null);
  }

  #events(calendarId: string, eventId?: string): string {
    const base = `calendars/${encodeURIComponent(calendarId)}/events`;
    return eventId === undefined ? base : `${base}/${encodeURIComponent(eventId)}`;
  }

  /** `events.list`, expanded to single events, ordered by start time. */
  async listEvents(
    calendarId: string,
    query: {
      timeMin?: string;
      timeMax?: string;
      q?: string;
      maxResults: number;
      pageToken?: string;
    },
    signal: AbortSignal,
  ) {
    return this.#get(
      this.#url(this.#events(calendarId), {
        timeMin: query.timeMin,
        timeMax: query.timeMax,
        q: query.q,
        maxResults: String(query.maxResults),
        pageToken: query.pageToken,
        singleEvents: "true",
        orderBy: "startTime",
      }),
      EventListSchema,
      signal,
    );
  }

  getEvent(calendarId: string, eventId: string, signal: AbortSignal): Promise<CalendarEvent> {
    return this.#get(this.#url(this.#events(calendarId, eventId)), EventSchema, signal);
  }

  async listCalendars(signal: AbortSignal) {
    return (await this.#get(this.#url("users/me/calendarList"), CalendarListSchema, signal)).items;
  }

  async insertEvent(
    calendarId: string,
    event: unknown,
    sendUpdates: SendUpdates,
    signal: AbortSignal,
  ) {
    const body = await this.#write(
      "POST",
      this.#url(this.#events(calendarId), { sendUpdates }),
      event,
      signal,
    );
    return EventSchema.parse(body);
  }

  async patchEvent(
    calendarId: string,
    eventId: string,
    patch: unknown,
    sendUpdates: SendUpdates,
    signal: AbortSignal,
  ) {
    const body = await this.#write(
      "PATCH",
      this.#url(this.#events(calendarId, eventId), { sendUpdates }),
      patch,
      signal,
    );
    return EventSchema.parse(body);
  }

  async deleteEvent(
    calendarId: string,
    eventId: string,
    sendUpdates: SendUpdates,
    signal: AbortSignal,
  ) {
    await this.#write(
      "DELETE",
      this.#url(this.#events(calendarId, eventId), { sendUpdates }),
      undefined,
      signal,
    );
  }
}
