import type { Tool } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type Definition, UpstreamError } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import type { Vault } from "../../vault/vault.ts";
import { Address, unique } from "../mail/compose.ts";
import { type FetchFn, mailboxSettings } from "../sign-in.ts";
import {
  listedTools,
  type Preparation,
  type ToolRow,
  toolRow,
  toolTableDefinition,
} from "../tool-table.ts";
import {
  type CalendarEvent,
  CalendarNotFoundError,
  CalendarWriteRefused,
  GoogleCalendarClient,
} from "./google-client.ts";

/**
 * The Google Calendar definition. Actions: `calendar.read`,
 * `calendar.event.create`, `calendar.event.update`, `calendar.event.delete`.
 *
 * - `recipients` are the attendees, because invites and updates send email.
 *   For an update, it is everyone on the event before or after the change,
 *   since both get mail; for a delete, everyone who would get a
 *   cancellation. The attendees count whatever `notify` says: Google notes
 *   that some emails may still be sent.
 * - `calendar` is the calendar id the call touches, with `primary` resolved
 *   to the account's own address, so a rule can name either.
 * - heel offers no tool that shares a calendar or watches one; both outlive
 *   revoking heel (I-70).
 */

interface CalendarBox {
  client: GoogleCalendarClient;
  /** The primary calendar's id: the account's address. */
  address: string;
}

type CalendarTool = ToolRow<CalendarBox>;
const calendarTool = toolRow<CalendarBox>();

const CalendarId = z
  .string()
  .regex(/^[^\s/]{1,256}$/, "expected a calendar id")
  .default("primary");
const EventId = z.string().regex(/^[A-Za-z0-9_-]{1,1024}$/, "expected an event id");

/** A time: a date-time with an offset or a time zone, or an all-day date. */
const When = z.union([
  z.strictObject({
    date_time: z.iso.datetime({ offset: true }),
    time_zone: z.string().max(64).optional(),
  }),
  z.strictObject({ date: z.iso.date() }),
]);
type WhenInput = z.output<typeof When>;

const Text = z.string().max(8_000);

function toGoogleTime(when: WhenInput) {
  return "date" in when
    ? { date: when.date }
    : {
        dateTime: when.date_time,
        ...(when.time_zone === undefined ? {} : { timeZone: when.time_zone }),
      };
}

function attendeeEmails(event: CalendarEvent): string[] {
  return event.attendees
    .map((a) => a.email?.toLowerCase())
    .filter((e): e is string => e !== undefined && e !== "");
}

function resolve(box: CalendarBox, calendarId: string): string {
  return calendarId === "primary" ? box.address : calendarId.toLowerCase();
}

/** An event as the agent reads it. */
function shown(event: CalendarEvent) {
  return {
    id: event.id,
    status: event.status ?? null,
    summary: event.summary ?? null,
    description: event.description ?? null,
    location: event.location ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    organizer: event.organizer?.email ?? null,
    attendees: event.attendees.map((a) => ({
      email: a.email ?? null,
      response: a.responseStatus ?? null,
    })),
    link: event.htmlLink ?? null,
  };
}

const listCalendars = calendarTool({
  returns: '{"calendars": [{"id", "name", "primary", "access"}, ...]}',
  description: "List the calendars this account can see, with their ids.",
  args: z.strictObject({}),
  readOnly: true,
  prepare: async (_box, args) => ({ args, action: "calendar.read" }),
  run: (box, _args, signal) => box.client.listCalendars(signal),
  show: async (_box, calendars: Awaited<ReturnType<GoogleCalendarClient["listCalendars"]>>) => ({
    calendars: calendars.map((c) => ({
      id: c.id,
      name: c.summary ?? null,
      primary: c.primary === true,
      access: c.accessRole ?? null,
    })),
  }),
});

const listEvents = calendarTool({
  returns:
    '{"events": [{"id", "status", "summary", "description", "location", "start", "end", "organizer", "attendees": [{"email", "response"}], "link"}, ...], "next_page_token"} (next_page_token only when there is a next page)',
  description:
    "List events on a calendar, as single occurrences in start order. Times are RFC 3339.",
  args: z.strictObject({
    calendar_id: CalendarId,
    time_min: z.iso.datetime({ offset: true }).optional(),
    time_max: z.iso.datetime({ offset: true }).optional(),
    query: z.string().max(500).optional(),
    max_results: z.number().int().min(1).max(250).default(50),
    page_token: z.string().max(1_000).optional(),
  }),
  readOnly: true,
  prepare: async (box, args) => ({
    args,
    calendar: resolve(box, args.calendar_id),
    action: "calendar.read",
  }),
  run: (box, args, signal) =>
    box.client.listEvents(
      args.calendar_id,
      {
        maxResults: args.max_results,
        ...(args.time_min === undefined ? {} : { timeMin: args.time_min }),
        ...(args.time_max === undefined ? {} : { timeMax: args.time_max }),
        ...(args.query === undefined ? {} : { q: args.query }),
        ...(args.page_token === undefined ? {} : { pageToken: args.page_token }),
      },
      signal,
    ),
  show: async (_box, page: { items: CalendarEvent[]; nextPageToken?: string | undefined }) => ({
    events: page.items.map(shown),
    ...(page.nextPageToken === undefined ? {} : { next_page_token: page.nextPageToken }),
  }),
});

const getEvent = calendarTool({
  returns:
    '{"id", "status", "summary", "description", "location", "start", "end", "organizer", "attendees": [{"email", "response"}], "link"}',
  description: "Read one event.",
  args: z.strictObject({ calendar_id: CalendarId, event_id: EventId }),
  readOnly: true,
  prepare: async (box, args) => ({
    args,
    calendar: resolve(box, args.calendar_id),
    action: "calendar.read",
  }),
  run: (box, args, signal) => box.client.getEvent(args.calendar_id, args.event_id, signal),
  show: async (_box, event: CalendarEvent) => shown(event),
});

const Notify = z
  .boolean()
  .default(true)
  .describe("Whether Google emails the attendees. Rules see the attendees either way.");

const created = async (_box: CalendarBox, event: unknown) => shown(event as CalendarEvent);

interface CreateArgs {
  calendar_id: string;
  summary: string;
  start: WhenInput;
  end: WhenInput;
  description?: string | undefined;
  location?: string | undefined;
  attendees: string[];
  notify: boolean;
}

const createEvent = calendarTool({
  returns:
    '{"id", "status", "summary", "description", "location", "start", "end", "organizer", "attendees": [{"email", "response"}], "link"}',
  description:
    "Create an event. Attendees get an invitation by email. Recipients are plain addresses.",
  args: z.strictObject({
    calendar_id: CalendarId,
    summary: z.string().min(1).max(1_000),
    start: When,
    end: When,
    description: Text.optional(),
    location: z.string().max(1_000).optional(),
    attendees: z.array(Address).max(100).default([]),
    notify: Notify,
  }),
  readOnly: false,
  async prepare(box, args): Promise<Preparation<CreateArgs>> {
    return {
      args,
      action: "calendar.event.create",
      recipients: unique(args.attendees),
      calendar: resolve(box, args.calendar_id),
    };
  },
  run: (box, args, signal) =>
    box.client.insertEvent(
      args.calendar_id,
      {
        summary: args.summary,
        start: toGoogleTime(args.start),
        end: toGoogleTime(args.end),
        ...(args.description === undefined ? {} : { description: args.description }),
        ...(args.location === undefined ? {} : { location: args.location }),
        attendees: args.attendees.map((email) => ({ email })),
      },
      args.notify ? "all" : "none",
      signal,
    ),
  show: created,
});

interface UpdateArgs {
  calendar_id: string;
  event_id: string;
  patch: Record<string, unknown>;
  notify: boolean;
}

const updateEvent = calendarTool({
  returns:
    '{"id", "status", "summary", "description", "location", "start", "end", "organizer", "attendees": [{"email", "response"}], "link"}',
  description:
    "Change an event. `attendees`, when given, replaces the whole list. Everyone on the event before " +
    "or after the change may get an update by email.",
  args: z.strictObject({
    calendar_id: CalendarId,
    event_id: EventId,
    summary: z.string().min(1).max(1_000).optional(),
    start: When.optional(),
    end: When.optional(),
    description: Text.optional(),
    location: z.string().max(1_000).optional(),
    attendees: z.array(Address).max(100).optional(),
    notify: Notify,
  }),
  readOnly: false,
  async prepare(box, args, _hiding, signal): Promise<Preparation<UpdateArgs>> {
    const existing = await box.client.getEvent(args.calendar_id, args.event_id, signal);
    const patch: Record<string, unknown> = {
      ...(args.summary === undefined ? {} : { summary: args.summary }),
      ...(args.start === undefined ? {} : { start: toGoogleTime(args.start) }),
      ...(args.end === undefined ? {} : { end: toGoogleTime(args.end) }),
      ...(args.description === undefined ? {} : { description: args.description }),
      ...(args.location === undefined ? {} : { location: args.location }),
      ...(args.attendees === undefined
        ? {}
        : { attendees: args.attendees.map((email) => ({ email })) }),
    };
    if (Object.keys(patch).length === 0) return { deny: "unsupported" };
    return {
      args: { calendar_id: args.calendar_id, event_id: existing.id, patch, notify: args.notify },
      action: "calendar.event.update",
      recipients: unique([...attendeeEmails(existing), ...(args.attendees ?? [])]),
      calendar: resolve(box, args.calendar_id),
      targets: [existing.id],
    };
  },
  run: (box, args, signal) =>
    box.client.patchEvent(
      args.calendar_id,
      args.event_id,
      args.patch,
      args.notify ? "all" : "none",
      signal,
    ),
  show: created,
});

const deleteEvent = calendarTool({
  returns: '{"deleted"} (the event id)',
  description: "Delete an event. Its attendees may get a cancellation by email.",
  args: z.strictObject({ calendar_id: CalendarId, event_id: EventId, notify: Notify }),
  readOnly: false,
  async prepare(box, args, _hiding, signal) {
    const existing = await box.client.getEvent(args.calendar_id, args.event_id, signal);
    return {
      args: { calendar_id: args.calendar_id, event_id: existing.id, notify: args.notify },
      action: "calendar.event.delete",
      recipients: unique(attendeeEmails(existing)),
      calendar: resolve(box, args.calendar_id),
      targets: [existing.id],
    };
  },
  async run(box, args, signal) {
    await box.client.deleteEvent(
      args.calendar_id,
      args.event_id,
      args.notify ? "all" : "none",
      signal,
    );
    return { deleted: args.event_id };
  },
  show: async (_box, result: unknown) => result,
});

const TOOLS: Record<string, CalendarTool> = {
  list_calendars: listCalendars,
  list_events: listEvents,
  get_event: getEvent,
  create_event: createEvent,
  update_event: updateEvent,
  delete_event: deleteEvent,
};

export const GOOGLE_CALENDAR_TOOLS: readonly Tool[] = listedTools(TOOLS);

export interface GoogleCalendarDeps {
  vault: Vault;
  fetch: FetchFn;
}

/** Null for an account that has never signed in (no address yet): its calls are denied. */
export function googleCalendarDefinition(
  account: AccountRecord,
  deps: GoogleCalendarDeps,
): Definition | null {
  const settings = mailboxSettings(account.settings);
  if (settings === null) return null;
  const box: CalendarBox = {
    client: new GoogleCalendarClient(deps.fetch, async () =>
      (await deps.vault.accessToken(account.id)).reveal(),
    ),
    address: settings.mailbox,
  };
  return toolTableDefinition({
    tools: TOOLS,
    listed: GOOGLE_CALENDAR_TOOLS,
    box,
    errors: {
      isNotFound: (error) => error instanceof CalendarNotFoundError,
      refusal: (error) =>
        error instanceof CalendarWriteRefused ? new UpstreamError(error.status, error.body) : null,
    },
    stateCheck: async () => "fail",
  });
}
