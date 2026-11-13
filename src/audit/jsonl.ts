import type { AuditKind } from "../core/audit.ts";
import type { PauseScope, RuleRef, Surface } from "../core/call.ts";

/**
 * The audit log's one external line format (spec: Teams, "Audit"). `heel
 * audit export` and the SIEM sink both emit exactly these bytes, so a
 * downstream parser never sees two dialects of the same row.
 */

/** A stored audit row, as the store reads it back. */
export interface StoredAuditRow {
  id: number;
  orgId: string;
  at: Date;
  kind: AuditKind;
  agentId: string;
  ownerId: string;
  runId: string | null;
  surface: Surface;
  account: string;
  provider: string;
  tool: string;
  action: string | null;
  args: unknown;
  callHash: string;
  rule: RuleRef | null;
  approvalId: string | null;
  standingApprovalId: string | null;
  approverId: string | null;
  pauseScope: PauseScope | null;
  reason: string | null;
}

/**
 * Pure: one row as a JSON object. Keys are fixed and always present (absent
 * values are `null`), `at` is ISO 8601 UTC, and `id` is the row's position
 * in the append-only log, which a consumer can use to detect gaps.
 */
export function auditExportRecord(row: StoredAuditRow): Record<string, unknown> {
  return {
    id: row.id,
    at: row.at.toISOString(),
    kind: row.kind,
    orgId: row.orgId,
    agentId: row.agentId,
    ownerId: row.ownerId,
    runId: row.runId,
    surface: row.surface,
    account: row.account,
    provider: row.provider,
    tool: row.tool,
    action: row.action,
    args: row.args,
    callHash: row.callHash,
    rule: row.rule,
    approvalId: row.approvalId,
    standingApprovalId: row.standingApprovalId,
    approverId: row.approverId,
    pauseScope: row.pauseScope,
    reason: row.reason,
  };
}

/** Pure: one row as a JSON Lines line, newline-terminated. */
export function auditJsonLine(row: StoredAuditRow): string {
  return `${JSON.stringify(auditExportRecord(row))}\n`;
}
