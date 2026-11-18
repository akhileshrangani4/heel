import { describe, expect, it } from "vitest";
import { GOOGLE_CALENDAR_TOOLS } from "../../../src/definitions/calendar/google.ts";
import { calendarPipeline } from "../../helpers/calendar-pipeline.ts";
import { OWNER_CALENDAR } from "../../helpers/fake-calendar.ts";

/** Google Calendar (D12a) through the real pipeline, against a fake calendar. */

const ALL = `rules:
  - match: { action: { one_of: [calendar.event.create, calendar.event.update, calendar.event.delete] } }
    then: allow
  - match: { kind: read }
    then: allow
`;

const MEETING = {
  summary: "Planning",
  start: { date_time: "2026-11-20T10:00:00Z" },
  end: { date_time: "2026-11-20T11:00:00Z" },
  attendees: ["bob@company.com"],
};

function setUp(owner = ALL) {
  const h = calendarPipeline({ owner });
  h.calendar.add({
    id: "e1",
    calendar: OWNER_CALENDAR,
    summary: "Sync",
    attendees: ["bob@company.com", "carol@vendor.com"],
  });
  return h;
}

describe("Google Calendar tools", () => {
  it("I-20: marks only the read tools read-only", () => {
    expect(
      GOOGLE_CALENDAR_TOOLS.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
    ).toEqual(["list_calendars", "list_events", "get_event"]);
  });

  it("creating an event: the attendees are the recipients, and Google is asked to email them", async () => {
    const h = setUp();
    expect(await h.call("create_event", MEETING)).toMatchObject({ status: "allowed" });
    expect(h.calendar.writes[0]).toMatchObject({ method: "POST", sendUpdates: "all" });
  });

  it("a rule on the attendees' domains applies to invites, even with notify off", async () => {
    const h = setUp(`rules:
  - match: { action: calendar.event.create, recipients: { any_domain_in: [rival.com] } }
    then: deny
${ALL.replace("rules:\n", "")}`);
    const result = await h.call("create_event", {
      ...MEETING,
      attendees: ["spy@rival.com"],
      notify: false,
    });
    expect(result).toMatchObject({ status: "denied" });
    expect(h.calendar.writes).toEqual([]);
  });

  it("an update's recipients include everyone on the event before the change", async () => {
    const h = setUp(`rules:
  - match: { action: calendar.event.update, recipients: { all_domain_in: [company.com] } }
    then: allow
`);
    // carol@vendor.com is on the event now; replacing the list still mails her.
    const result = await h.call("update_event", { event_id: "e1", attendees: ["bob@company.com"] });
    expect(result).toMatchObject({ status: "denied" });
  });

  it("a delete's recipients are the attendees who'd get a cancellation", async () => {
    const h = setUp(`rules:
  - match: { action: calendar.event.delete, recipients: { all_domain_in: [company.com] } }
    then: allow
`);
    expect(await h.call("delete_event", { event_id: "e1" })).toMatchObject({ status: "denied" });
    expect(h.calendar.events.has("e1")).toBe(true);
  });

  it("rules can name the calendar, with primary resolved to the account's address", async () => {
    const h = setUp(`rules:
  - match: { action: calendar.event.create, calendar: ${OWNER_CALENDAR} }
    then: allow
`);
    expect(await h.call("create_event", MEETING)).toMatchObject({ status: "allowed" });
    expect(
      await h.call("create_event", { ...MEETING, calendar_id: "team@group.calendar.google.com" }),
    ).toMatchObject({
      status: "denied",
    });
  });

  it("a missing event is not_available, before any write", async () => {
    const h = setUp();
    expect(await h.call("delete_event", { event_id: "nope" })).toEqual({
      status: "denied",
      reason: "not_available",
      rule: null,
    });
  });
});
