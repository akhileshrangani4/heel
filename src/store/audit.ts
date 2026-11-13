import { type AuditEvent, type AuditRecord, toAuditRecord } from "../core/audit.ts";
import type { HeelDb, HeelTx } from "./db.ts";
import { auditLog } from "./schema.ts";

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
