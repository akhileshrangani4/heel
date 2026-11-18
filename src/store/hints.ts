import { and, asc, desc, eq, ne } from "drizzle-orm";
import type { ApprovalHints } from "../core/hints.ts";
import type { HeelDb } from "./db.ts";
import { approvalHints, auditLog } from "./schema.ts";

/** Stores one adapter's hints for a request; a later answer from the same adapter replaces it. */
export function saveHints(
  db: HeelDb,
  approvalId: string,
  adapter: string,
  result: ApprovalHints,
  at: Date,
): void {
  const row = {
    status: result.status,
    hints: result.status === "ok" ? result.hints : [],
    detail: result.status === "ok" ? null : result.detail,
    createdAt: at,
  };
  db.insert(approvalHints)
    .values({ approvalId, adapter, ...row })
    .onConflictDoUpdate({ target: [approvalHints.approvalId, approvalHints.adapter], set: row })
    .run();
}

export interface StoredHints {
  adapter: string;
  result: ApprovalHints;
}

/** Every adapter's hints for a request, in adapter name order. */
export function hintsFor(db: HeelDb, approvalId: string): StoredHints[] {
  return db
    .select()
    .from(approvalHints)
    .where(eq(approvalHints.approvalId, approvalId))
    .orderBy(asc(approvalHints.adapter))
    .all()
    .map((row) => ({
      adapter: row.adapter,
      result:
        row.status === "ok"
          ? { status: "ok" as const, hints: row.hints }
          : { status: "unavailable" as const, detail: row.detail ?? "" },
    }));
}

export interface RecentCall {
  account: string;
  tool: string;
  action: string | null;
  /** The audit kind: allowed, denied, pending, … */
  outcome: string;
}

/** An agent's latest calls from the audit log, newest first, leaving out one call hash. */
export function recentCalls(
  db: HeelDb,
  orgId: string,
  agentId: string,
  exceptCallHash: string,
  limit = 15,
): RecentCall[] {
  return db
    .select({
      account: auditLog.account,
      tool: auditLog.tool,
      action: auditLog.action,
      outcome: auditLog.kind,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.orgId, orgId),
        eq(auditLog.agentId, agentId),
        ne(auditLog.callHash, exceptCallHash),
      ),
    )
    .orderBy(desc(auditLog.id))
    .limit(limit)
    .all();
}
