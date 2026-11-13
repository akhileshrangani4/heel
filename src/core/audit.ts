import type { Call, PauseScope, RuleRef, Surface } from "./call.ts";

/**
 * What one audit row says (I-73): every decision and every approval
 * transition, with the agent, run id, arguments, the deciding rule or
 * approval, and the approver. Pure: the store appends what this builds.
 */
export const AUDIT_KINDS = [
  "allow",
  "deny",
  "ask",
  "paused",
  "expired",
  "approved",
  "approval_denied",
  "executed",
] as const;
export type AuditKind = (typeof AUDIT_KINDS)[number];

interface CallEvent {
  call: Call;
  /** The canonical call hash: the approval key for this call. */
  callHash: string;
}

/**
 * One variant per kind, each requiring the fields that make its row
 * complete. The audit_log CHECK constraint enforces the same table, so a
 * row the types would reject can't be written by any other path either.
 */
export type AuditEvent =
  | (CallEvent & {
      kind: "allow";
      rule: RuleRef;
      /** Set when a standing approval above `rule` turned its ask into allow. */
      standingApprovalId?: string;
    })
  | (CallEvent & {
      kind: "deny";
      /** Null for the default deny and for hard denies that ignore rules. */
      rule: RuleRef | null;
      reason: string;
    })
  | (CallEvent & { kind: "ask"; rule: RuleRef; approvalId: string })
  | (CallEvent & { kind: "paused"; pauseScope: PauseScope })
  | (CallEvent & { kind: "expired"; approvalId: string })
  | (CallEvent & {
      kind: "approved";
      approvalId: string;
      approverId: string;
      /** Set when the approver granted a standing approval. */
      standingApprovalId?: string;
    })
  | (CallEvent & { kind: "approval_denied"; approvalId: string; approverId: string })
  | (CallEvent & { kind: "executed"; approvalId: string; rule?: RuleRef });

/** The flat row shape the store appends. */
export interface AuditRecord {
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

/** Flattens an event into the row the audit log stores. */
export function toAuditRecord(event: AuditEvent, at: Date): AuditRecord {
  const { call } = event;
  return {
    orgId: call.orgId,
    at,
    kind: event.kind,
    agentId: call.agentId,
    ownerId: call.ownerId,
    runId: call.runId ?? null,
    surface: call.surface,
    account: call.account,
    provider: call.provider,
    tool: call.tool,
    action: call.action ?? null,
    // MCP treats absent `arguments` as none, so a call without them is recorded as `{}`.
    args: call.args ?? {},
    callHash: event.callHash,
    rule: "rule" in event ? (event.rule ?? null) : null,
    approvalId: "approvalId" in event ? event.approvalId : null,
    standingApprovalId: "standingApprovalId" in event ? (event.standingApprovalId ?? null) : null,
    approverId: "approverId" in event ? event.approverId : null,
    pauseScope: event.kind === "paused" ? event.pauseScope : null,
    reason: event.kind === "deny" ? event.reason : null,
  };
}
