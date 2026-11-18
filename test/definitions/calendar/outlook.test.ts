import { describe, expect, it } from "vitest";
import { MAILBOX } from "../../helpers/fake-graph.ts";
import { outlookPipeline } from "../../helpers/outlook-pipeline.ts";

/** Outlook calendar (D12a) through the real pipeline, against the fake Graph. */

const MEETING = {
  subject: "Planning",
  start: { date_time: "2026-11-20T10:00" },
  end: { date_time: "2026-11-20T11:00" },
  attendees: ["Bob@Company.com"],
};

describe("Outlook calendar tools", () => {
  it("create: the attendees are the recipients; rules on their domains apply", async () => {
    const h = outlookPipeline({
      owner: `rules:
  - match: { action: calendar.event.create, recipients: { all_domain_in: [company.com] } }
    then: allow
`,
    });
    expect(await h.call("create_event", MEETING)).toMatchObject({ status: "allowed" });
    expect(
      await h.call("create_event", { ...MEETING, attendees: ["spy@rival.com"] }),
    ).toMatchObject({
      status: "denied",
    });
    expect(h.graph.eventWrites).toHaveLength(1);
  });

  it("update counts everyone on the event before the change; delete counts who'd be cancelled", async () => {
    const h = outlookPipeline({
      owner: `rules:
  - match: { action: { one_of: [calendar.event.update, calendar.event.delete] }, recipients: { all_domain_in: [company.com] } }
    then: allow
`,
    });
    h.graph.events.set("evt-1", {
      id: "evt-1",
      subject: "Sync",
      attendees: ["bob@company.com", "carol@vendor.com"],
    });
    expect(
      await h.call("update_event", { event_id: "evt-1", attendees: ["bob@company.com"] }),
    ).toMatchObject({ status: "denied" });
    expect(await h.call("delete_event", { event_id: "evt-1" })).toMatchObject({ status: "denied" });
    expect(h.graph.eventWrites).toEqual([]);
  });

  it("rules can name the calendar; the default calendar is the mailbox's address", async () => {
    const h = outlookPipeline({
      owner: `rules:
  - match: { action: calendar.event.create, calendar: ${MAILBOX} }
    then: allow
`,
    });
    expect(await h.call("create_event", MEETING)).toMatchObject({ status: "allowed" });
  });
});
