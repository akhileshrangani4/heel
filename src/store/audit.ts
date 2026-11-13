import { and, asc, count, eq, gt, gte, lt, lte, max, min, type SQL, sql } from "drizzle-orm";
import type { StoredAuditRow } from "../audit/jsonl.ts";
import { type AuditEvent, type AuditRecord, toAuditRecord } from "../core/audit.ts";
import type { HeelDb, HeelTx } from "./db.ts";
import { auditLog, siemCursors } from "./schema.ts";

/**
 * The only write path into the audit log. Pass the decision's transaction so
 * the row commits with the count reservation or approval change it records,
 * or not at all: a call never runs unless its audit row is committed first
 * (spec: Fail-closed behavior). A failed insert throws, and the caller denies.
 */
export function appendAudit(db: HeelDb | HeelTx, event: AuditEvent, at: Date = new Date()): number {
  const record: AuditRecord = toAuditRecord(event, at);
  const row = db.insert(auditLog).values(record).returning({ id: auditLog.id }).get();
  return row.id;
}

/** The newest row id in an org's audit log, or 0 when it is empty. */
export function latestAuditId(db: HeelDb, orgId: string): number {
  const row = db
    .select({ id: max(auditLog.id) })
    .from(auditLog)
    .where(eq(auditLog.orgId, orgId))
    .get();
  return row?.id ?? 0;
}

export interface AuditPageQuery {
  orgId: string;
  /** Rows with an id above this; 0 starts at the beginning. */
  afterId: number;
  /** Rows with an id at or below this; pins a snapshot while paging. */
  throughId: number;
  /** Inclusive lower bound on `at`. */
  since?: Date;
  /** Exclusive upper bound on `at`. */
  until?: Date;
  limit: number;
}

/**
 * Reads audit rows in id order, which is append order. Ids, not timestamps,
 * drive paging: two rows can share a millisecond, and a clock step backwards
 * must not hide a row from export or the SIEM sink.
 */
export function readAuditPage(db: HeelDb, query: AuditPageQuery): StoredAuditRow[] {
  const conditions: SQL[] = [
    eq(auditLog.orgId, query.orgId),
    gt(auditLog.id, query.afterId),
    lte(auditLog.id, query.throughId),
  ];
  if (query.since) conditions.push(gte(auditLog.at, query.since));
  if (query.until) conditions.push(lt(auditLog.at, query.until));
  return db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(asc(auditLog.id))
    .limit(query.limit)
    .all();
}

export interface AuditBacklog {
  /** Rows after the cursor. */
  rows: number;
  /** When the oldest of them was written; null when there are none. */
  oldestAt: Date | null;
}

/** How many audit rows a consumer at `afterId` has not yet taken, and how old the oldest is. */
export function auditBacklog(db: HeelDb, orgId: string, afterId: number): AuditBacklog {
  const row = db
    .select({ rows: count(), oldestAt: min(auditLog.at) })
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), gt(auditLog.id, afterId)))
    .get();
  return { rows: row?.rows ?? 0, oldestAt: row?.oldestAt ?? null };
}

/** The highest audit row id `sink` has acknowledged, or 0 before its first batch. */
export function readSiemCursor(db: HeelDb, orgId: string, sink: string): number {
  const row = db
    .select({ id: siemCursors.deliveredThroughId })
    .from(siemCursors)
    .where(and(eq(siemCursors.orgId, orgId), eq(siemCursors.sink, sink)))
    .get();
  return row?.id ?? 0;
}

/**
 * Records that `sink` acknowledged every row through `throughId`. The cursor
 * only moves forward, so a late write can never re-open delivered rows.
 */
export function advanceSiemCursor(
  db: HeelDb,
  orgId: string,
  sink: string,
  throughId: number,
  at: Date,
): void {
  db.insert(siemCursors)
    .values({ orgId, sink, deliveredThroughId: throughId, updatedAt: at })
    .onConflictDoUpdate({
      target: [siemCursors.orgId, siemCursors.sink],
      set: {
        deliveredThroughId: sql`max(${siemCursors.deliveredThroughId}, excluded.delivered_through_id)`,
        updatedAt: at,
      },
    })
    .run();
}
