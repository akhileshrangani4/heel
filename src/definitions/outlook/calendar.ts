import { z } from "zod";
import { Address, unique } from "../mail/compose.ts";
import { GRAPH_API_BASE } from "../microsoft/oauth.ts";
import type { Preparation } from "../tool-table.ts";
import type { GraphEvent } from "./client.ts";
import type { OutlookMailbox } from "./messages.ts";
import { OutlookId, type OutlookTool, outlookTool } from "./tool.ts";

/**
 * Outlook calendar, on the
 * same Outlook account as its mail. The same actions and facts as Google
 * Calendar:
 *
 * - `recipients` are the attendees: Graph sends invitations when an event
 *   with attendees is created, updates when it changes, and cancellations
 *   when the organizer deletes it. An update counts everyone before and after
 *   the change.
 * - `calendar` is the calendar id, with the default calendar named by the
 *   account's address.
 * - No tool shares a calendar or subscribes to changes (I-70).
 *
 * The Graph v1.0 reference each call was written against
 * (https://learn.microsoft.com/en-us/graph/api/<page>?view=graph-rest-1.0):
 * - user-list-calendarview: startDateTime and endDateTime are required, and
 *   $top is 1 to 1000.
 * - user-post-events: "the server sends invitations to all attendees ... and
 *   can't be configured".
 * - event-update: an attendees-only change mails the changed attendees.
 *   heel counts everyone, before and after.
 * - event-delete: for the organizer it "sends a cancellation message to the
 *   meeting attendees".
 * - user-list-calendars, event-get.
 * heel offers no cancel, forward, accept or decline (forward and the replies
 * send mail outside the attendee list), and no calendarPermission or
 * subscription calls.
 */

const Text = z.string().max(8_000);
const DEFAULT = "default";

/** A Graph time: a local date-time and a time zone name. */
const When = z.strictObject({
  date_time: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/, "expected YYYY-MM-DDTHH:MM"),
  time_zone: z.string().min(1).max(64).default("UTC"),
});
type WhenInput = z.output<typeof When>;

const CalendarId = z.union([z.literal(DEFAULT), OutlookId]).default(DEFAULT);

function graphTime(when: WhenInput) {
  return { dateTime: when.date_time, timeZone: when.time_zone };
}

function attendeeEmails(event: GraphEvent): string[] {
  return event.attendees
    .map((a) => a.emailAddress.address?.toLowerCase())
    .filter((e): e is string => e !== undefined && e !== null && e !== "");
}

const graphAttendees = (emails: readonly string[]) =>
  emails.map((address) => ({ emailAddress: { address }, type: "required" }));

function calendarFact(box: OutlookMailbox, calendarId: string): string {
  return calendarId === DEFAULT ? box.address : calendarId;
}

function shown(event: GraphEvent) {
  return {
    id: event.id,
    subject: event.subject ?? null,
    preview: event.bodyPreview ?? null,
    start: event.start ?? null,
    end: event.end ?? null,
    location: event.location?.displayName ?? null,
    organizer: event.organizer?.emailAddress.address ?? null,
    attendees: event.attendees.map((a) => ({
      email: a.emailAddress.address ?? null,
      response: a.status?.response ?? null,
    })),
    cancelled: event.isCancelled === true,
    link: event.webLink ?? null,
  };
}

const listCalendars = outlookTool({
  returns: '{"calendars": [{"id", "name", "default"}, ...]}',
  description: "List this mailbox's calendars, with their ids.",
  args: z.strictObject({}),
  readOnly: true,
  prepare: async (_box, args) => ({ args, action: "calendar.read" }),
  run: (box, _args, signal) => box.client.listCalendars(signal),
  show: async (
    _box,
    calendars: Awaited<ReturnType<OutlookMailbox["client"]["listCalendars"]>>,
  ) => ({
    calendars: calendars.map((c) => ({
      id: c.id,
      name: c.name ?? null,
      default: c.isDefaultCalendar === true,
    })),
  }),
});

const listEvents = outlookTool({
  returns:
    '{"events": [{"id", "subject", "preview", "start", "end", "location", "organizer", "attendees": [{"email", "response"}], "cancelled", "link"}, ...], "next_page_token"} (next_page_token only when there is a next page)',
  description:
    "List event occurrences between two instants (ISO 8601) on a calendar, `default` for the default one.",
  args: z.strictObject({
    calendar_id: CalendarId,
    start: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    max_results: z.number().int().min(1).max(100).default(50),
    page_token: z.string().max(4_000).optional(),
  }),
  readOnly: true,
  async prepare(box, args) {
    if (args.page_token !== undefined && !args.page_token.startsWith(`${GRAPH_API_BASE}me/`)) {
      return { deny: "unsupported" as const };
    }
    return { args, action: "calendar.read", calendar: calendarFact(box, args.calendar_id) };
  },
  run: (box, args, signal) =>
    box.client.calendarView(
      args.page_token !== undefined
        ? { nextLink: args.page_token }
        : {
            calendarId: args.calendar_id === DEFAULT ? null : args.calendar_id,
            start: args.start,
            end: args.end,
            top: args.max_results,
          },
      signal,
    ),
  show: async (_box, page: { events: GraphEvent[]; nextLink: string | undefined }) => ({
    events: page.events.map(shown),
    ...(page.nextLink === undefined ? {} : { next_page_token: page.nextLink }),
  }),
});

const getEvent = outlookTool({
  returns:
    '{"id", "subject", "preview", "start", "end", "location", "organizer", "attendees": [{"email", "response"}], "cancelled", "link"}',
  description: "Read one event.",
  args: z.strictObject({ event_id: OutlookId }),
  readOnly: true,
  prepare: async (_box, args) => ({ args, action: "calendar.read" }),
  run: (box, args, signal) => box.client.getEvent(args.event_id, signal),
  show: async (_box, event: GraphEvent) => shown(event),
});

interface CreateArgs {
  calendar_id: string;
  event: Record<string, unknown>;
}

const createEvent = outlookTool({
  returns:
    '{"id", "subject", "preview", "start", "end", "location", "organizer", "attendees": [{"email", "response"}], "cancelled", "link"}',
  description:
    "Create an event. Graph emails each attendee an invitation. Recipients are plain addresses.",
  args: z.strictObject({
    calendar_id: CalendarId,
    subject: z.string().min(1).max(1_000),
    start: When,
    end: When,
    body: Text.optional(),
    location: z.string().max(1_000).optional(),
    attendees: z.array(Address).max(100).default([]),
  }),
  readOnly: false,
  async prepare(box, args): Promise<Preparation<CreateArgs>> {
    const attendees = unique(args.attendees);
    return {
      args: {
        calendar_id: args.calendar_id,
        event: {
          subject: args.subject,
          start: graphTime(args.start),
          end: graphTime(args.end),
          ...(args.body === undefined ? {} : { body: { contentType: "text", content: args.body } }),
          ...(args.location === undefined ? {} : { location: { displayName: args.location } }),
          attendees: graphAttendees(attendees),
        },
      },
      action: "calendar.event.create",
      recipients: attendees,
      calendar: calendarFact(box, args.calendar_id),
    };
  },
  run: (box, args, signal) =>
    box.client.createEvent(
      args.calendar_id === DEFAULT ? null : args.calendar_id,
      args.event,
      signal,
    ),
  show: async (_box, event: GraphEvent) => shown(event),
});

const updateEvent = outlookTool({
  returns:
    '{"id", "subject", "preview", "start", "end", "location", "organizer", "attendees": [{"email", "response"}], "cancelled", "link"}',
  description:
    "Change an event. `attendees`, when given, replaces the whole list. Graph emails everyone on it an update.",
  args: z.strictObject({
    event_id: OutlookId,
    subject: z.string().min(1).max(1_000).optional(),
    start: When.optional(),
    end: When.optional(),
    body: Text.optional(),
    location: z.string().max(1_000).optional(),
    attendees: z.array(Address).max(100).optional(),
  }),
  readOnly: false,
  async prepare(
    _box,
    args,
    _hiding,
    signal,
  ): Promise<Preparation<{ event_id: string; patch: Record<string, unknown> }>> {
    const existing = await _box.client.getEvent(args.event_id, signal);
    const patch: Record<string, unknown> = {
      ...(args.subject === undefined ? {} : { subject: args.subject }),
      ...(args.start === undefined ? {} : { start: graphTime(args.start) }),
      ...(args.end === undefined ? {} : { end: graphTime(args.end) }),
      ...(args.body === undefined ? {} : { body: { contentType: "text", content: args.body } }),
      ...(args.location === undefined ? {} : { location: { displayName: args.location } }),
      ...(args.attendees === undefined
        ? {}
        : { attendees: graphAttendees(unique(args.attendees)) }),
    };
    if (Object.keys(patch).length === 0) return { deny: "unsupported" };
    return {
      args: { event_id: existing.id, patch },
      action: "calendar.event.update",
      recipients: unique([...attendeeEmails(existing), ...(args.attendees ?? [])]),
      targets: [existing.id],
    };
  },
  run: (box, args, signal) => box.client.patchEvent(args.event_id, args.patch, signal),
  show: async (_box, event: GraphEvent) => shown(event),
});

const deleteEvent = outlookTool({
  returns: '{"deleted"} (the event id)',
  description: "Delete an event. If you organize it, Graph emails its attendees a cancellation.",
  args: z.strictObject({ event_id: OutlookId }),
  readOnly: false,
  async prepare(box, args, _hiding, signal) {
    const existing = await box.client.getEvent(args.event_id, signal);
    return {
      args: { event_id: existing.id },
      action: "calendar.event.delete",
      recipients: unique(attendeeEmails(existing)),
      targets: [existing.id],
    };
  },
  async run(box, args, signal) {
    await box.client.deleteEvent(args.event_id, signal);
    return { deleted: args.event_id };
  },
  show: async (_box, result: unknown) => result,
});

export const CALENDAR_TOOLS: Record<string, OutlookTool> = {
  list_calendars: listCalendars,
  list_events: listEvents,
  get_event: getEvent,
  create_event: createEvent,
  update_event: updateEvent,
  delete_event: deleteEvent,
};
