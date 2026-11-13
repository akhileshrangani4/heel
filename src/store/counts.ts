import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  COUNT_RETENTION_MS,
  type CountEvent,
  currentRunSpan,
  hourWindowStart,
  parseStoredFacts,
  type StoredFacts,
} from "../core/counts.ts";
import type { HeelDb, HeelTx } from "./db.ts";
import { countEvents } from "./schema.ts";

/**
 * Count events (spec: Counts and state checks, "Item counts"). Every call
 * heel lets run writes one row in its decision transaction: rule-allowed
 * calls, approved re-runs and watch-mode pass-throughs. Rows are never
 * refunded, so a batch that half-succeeded still counts in full.
 */

type Query = HeelDb | HeelTx;

/** A stored count event that doesn't parse; the decision that read it is denied. */
export class CorruptCountEventError extends Error {
  readonly rowId: number;

  constructor(rowId: number) {
    super(`count event ${rowId} does not hold a call's facts`);
    this.name = "CorruptCountEventError";
    this.rowId = rowId;
  }
}

export interface CountReservation {
  orgId: string;
  agentId: string;
  runId: string | null;
  facts: StoredFacts;
  items: number;
  at: Date;
}

/** Reserves a call's items. Pass the decision transaction so it commits with the audit row. */
export function reserveCount(db: Query, reservation: CountReservation): void {
  db.insert(countEvents)
    .values({
      orgId: reservation.orgId,
      agentId: reservation.agentId,
      runId: reservation.runId,
      fields: reservation.facts,
      items: reservation.items,
      at: reservation.at,
    })
    .run();
}

export type CountWindow = { per: "hour" } | { per: "run"; runId: string };

/**
 * One agent's events in a window, oldest first.
 *
 * - `hour`: the sliding 60 minutes ending at `now`, whatever the run id (I-25).
 * - `run`: the events of `(agent, runId)` since the run last sat idle for
 *   the retention (`currentRunSpan`), so the answer never depends on when
 *   the pruner last ran.
 */
export function readCountWindow(
  db: Query,
  agentId: string,
  window: CountWindow,
  now: Date,
): CountEvent[] {
  const condition =
    window.per === "hour"
      ? and(eq(countEvents.agentId, agentId), gt(countEvents.at, hourWindowStart(now)))
      : and(eq(countEvents.agentId, agentId), eq(countEvents.runId, window.runId));
  const rows = db
    .select()
    .from(countEvents)
    .where(condition)
    .orderBy(asc(countEvents.at), asc(countEvents.id))
    .all();
  const live = window.per === "run" ? currentRunSpan(rows, now) : rows;
  return live.map((row) => {
    const facts = parseStoredFacts(row.fields);
    if (facts === null) throw new CorruptCountEventError(row.id);
    return { runId: row.runId, facts, items: row.items };
  });
}

/**
 * Deletes count events nothing can count any more: events with no run id
 * older than the retention, and every event of a run whose last call is
 * older than the retention. Returns how many rows went.
 */
export function pruneCountEvents(db: HeelDb, now: Date): number {
  const cutoff = now.getTime() - COUNT_RETENTION_MS;
  const result = db.run(sql`
    DELETE FROM count_events
    WHERE at <= ${cutoff}
      AND (
        run_id IS NULL
        OR NOT EXISTS (
          SELECT 1 FROM count_events AS newer
          WHERE newer.agent_id = count_events.agent_id
            AND newer.run_id = count_events.run_id
            AND newer.at > ${cutoff}
        )
      )
  `);
  return result.changes;
}
