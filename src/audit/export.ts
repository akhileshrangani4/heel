import { latestAuditId, readAuditPage } from "../store/audit.ts";
import type { HeelDb } from "../store/db.ts";
import { auditJsonLine } from "./jsonl.ts";

/**
 * `heel audit export` (spec: Teams, "Audit"). The admin socket answers one
 * line per request, so export pages through the log. The first page pins
 * the newest row id as `throughId`; later pages pass it back, so rows
 * appended while an export runs never shift or extend its snapshot.
 */

export interface AuditExportParams {
  since?: Date;
  until?: Date;
  afterId: number;
  throughId?: number;
  limit: number;
}

export interface AuditExportPage {
  /** JSON Lines, each newline-terminated, in append order. */
  lines: string[];
  /** The snapshot's last row id; pass it back on every later page. */
  throughId: number;
  /** Pass as `afterId` for the next page. */
  nextAfterId: number;
  /** True when this page reached the end of the snapshot. */
  done: boolean;
}

export function exportAuditPage(
  db: HeelDb,
  orgId: string,
  params: AuditExportParams,
): AuditExportPage {
  const throughId = params.throughId ?? latestAuditId(db, orgId);
  const rows = readAuditPage(db, {
    orgId,
    afterId: params.afterId,
    throughId,
    limit: params.limit,
    ...(params.since ? { since: params.since } : {}),
    ...(params.until ? { until: params.until } : {}),
  });
  const last = rows.at(-1);
  return {
    lines: rows.map(auditJsonLine),
    throughId,
    nextAfterId: last?.id ?? params.afterId,
    done: rows.length < params.limit,
  };
}
