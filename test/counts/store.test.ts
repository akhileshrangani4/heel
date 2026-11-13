import { describe, expect, it } from "vitest";
import { COUNT_RETENTION_MS, HOUR_MS, type StoredFacts } from "../../src/core/counts.ts";
import {
  CorruptCountEventError,
  pruneCountEvents,
  readCountWindow,
  reserveCount,
} from "../../src/store/counts.ts";
import { newId } from "../../src/store/ids.ts";
import { agents, countEvents } from "../../src/store/schema.ts";
import { reopen, type TestStore, testStore } from "../helpers/store.ts";

/** The count-event store: reservations, windows and pruning over real SQLite. */

const NOW = new Date("2026-11-13T12:00:00.000Z");
const FACTS: StoredFacts = { agent: "inbox-bot", account: "gmail-work", action: "email.remove" };

function addAgent(t: TestStore, name: string): string {
  const id = newId("agent");
  t.db
    .insert(agents)
    .values({ id, orgId: t.orgId, ownerId: t.ownerId, name, createdAt: NOW })
    .run();
  return id;
}

function reserve(t: TestStore, agentId: string, runId: string | null, items: number, at: Date) {
  reserveCount(t.db, { orgId: t.orgId, agentId, runId, facts: FACTS, items, at });
}

const ago = (ms: number) => new Date(NOW.getTime() - ms);
const itemsOf = (events: { items: number }[]) => events.map((e) => e.items);

describe("count windows", () => {
  it("I-25: the hour window holds every run's events, and calls with none", () => {
    const t = testStore();
    const agent = addAgent(t, "inbox-bot");
    reserve(t, agent, "run-a", 5, ago(30 * 60_000));
    reserve(t, agent, "run-b", 7, ago(20 * 60_000));
    reserve(t, agent, null, 2, ago(10 * 60_000));

    expect(itemsOf(readCountWindow(t.db, agent, { per: "hour" }, NOW))).toEqual([5, 7, 2]);
  });

  it("slides: an event exactly an hour old has left the window", () => {
    const t = testStore();
    const agent = addAgent(t, "inbox-bot");
    reserve(t, agent, null, 1, ago(HOUR_MS));
    reserve(t, agent, null, 2, ago(HOUR_MS - 1));

    expect(itemsOf(readCountWindow(t.db, agent, { per: "hour" }, NOW))).toEqual([2]);
  });

  it("the run window holds only that run's events, from any age while the run is live", () => {
    const t = testStore();
    const agent = addAgent(t, "inbox-bot");
    reserve(t, agent, "run-a", 5, ago(3 * 24 * HOUR_MS));
    reserve(t, agent, "run-b", 7, ago(HOUR_MS));
    reserve(t, agent, "run-a", 1, ago(60_000));
    reserve(t, agent, null, 9, ago(60_000));

    const run = readCountWindow(t.db, agent, { per: "run", runId: "run-a" }, NOW);
    expect(run).toEqual([
      { runId: "run-a", facts: FACTS, items: 5 },
      { runId: "run-a", facts: FACTS, items: 1 },
    ]);
  });

  it("keeps two agents' counts apart, even under the same run id", () => {
    const t = testStore();
    const inbox = addAgent(t, "inbox-bot");
    const ci = addAgent(t, "ci-bot");
    reserve(t, inbox, "r1", 4, ago(60_000));
    reserve(t, ci, "r1", 6, ago(60_000));

    expect(itemsOf(readCountWindow(t.db, inbox, { per: "run", runId: "r1" }, NOW))).toEqual([4]);
    expect(itemsOf(readCountWindow(t.db, ci, { per: "hour" }, NOW))).toEqual([6]);
  });

  it("refuses a row whose facts don't parse instead of counting it as something else", () => {
    const t = testStore();
    const agent = addAgent(t, "inbox-bot");
    t.db
      .insert(countEvents)
      .values({ orgId: t.orgId, agentId: agent, runId: null, fields: {}, items: 3, at: ago(1000) })
      .run();

    expect(() => readCountWindow(t.db, agent, { per: "hour" }, NOW)).toThrow(
      CorruptCountEventError,
    );
  });

  it("I-04: count events survive a restart", () => {
    const t = testStore();
    const agent = addAgent(t, "inbox-bot");
    reserve(t, agent, "run-a", 20, ago(60_000));

    const restarted = reopen(t);

    expect(
      itemsOf(readCountWindow(restarted.db, agent, { per: "run", runId: "run-a" }, NOW)),
    ).toEqual([20]);
  });
});

describe("pruning", () => {
  it("deletes what nothing can count: old events with no run id, and runs idle for 7 days", () => {
    const t = testStore();
    const agent = addAgent(t, "inbox-bot");
    const old = ago(COUNT_RETENTION_MS + HOUR_MS);
    reserve(t, agent, null, 1, old); // gone
    reserve(t, agent, null, 2, ago(HOUR_MS)); // kept
    reserve(t, agent, "idle-run", 3, old); // gone: the run's last call is old
    reserve(t, agent, "live-run", 4, old); // kept: the run's last call is recent
    reserve(t, agent, "live-run", 5, ago(COUNT_RETENTION_MS - HOUR_MS));

    expect(pruneCountEvents(t.db, NOW)).toBe(2);
    const left = t.db.select().from(countEvents).all();
    expect(left.map((row) => row.items).sort()).toEqual([2, 4, 5]);
    expect(itemsOf(readCountWindow(t.db, agent, { per: "run", runId: "live-run" }, NOW))).toEqual([
      4, 5,
    ]);
  });
});
