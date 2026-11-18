import { and, eq } from "drizzle-orm";
import type { ApprovalTtls } from "../../src/core/approvals.ts";
import type { PipelineResult } from "../../src/gateway/pipeline/ports.ts";
import {
  type Approver,
  type DecideResult,
  decideApproval,
  SqliteApprovalStore,
  type StandingChoice,
} from "../../src/store/approvals.ts";
import { newId } from "../../src/store/ids.ts";
import { type PauseKey, pause, resume, SqlitePauseStore } from "../../src/store/pauses.ts";
import { approvals, type UserRole, users } from "../../src/store/schema.ts";
import { type HarnessOptions, type PipelineHarness, pipelineHarness } from "./pipeline.ts";

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const SEND = { action: "email.send", recipients: ["bob@vendor.com"], subject: "Q3" };

/** The D3 pipeline over D4b's SQLite approval and pause stores. */
export interface ApprovalHarness extends PipelineHarness {
  store: SqliteApprovalStore;
  pauseStore: SqlitePauseStore;
  /** The local owner: an admin who owns every harness account. */
  owner: Approver;
  addUser(name: string, role: UserRole): Approver;
  decide(
    approvalId: string,
    intent: "approve" | "deny",
    options?: { by?: Approver; standing?: StandingChoice; callHash?: string },
  ): DecideResult;
  status(approvalId: string): string;
  pause(key: PauseKey): void;
  resume(key: PauseKey): void;
}

export function approvalHarness(
  options: HarnessOptions & { ttls?: ApprovalTtls } = {},
): ApprovalHarness {
  const store = new SqliteApprovalStore(options.ttls);
  const pauseStore = new SqlitePauseStore();
  const h = pipelineHarness({ ...options, approvalStore: store, pauseStore });
  const owner: Approver = { orgId: h.t.orgId, userId: h.t.ownerId, role: "admin" };
  const hashOf = (approvalId: string): string => {
    const row = h.t.db
      .select({ callHash: approvals.callHash })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .get();
    if (row === undefined) throw new Error(`no approval ${approvalId}`);
    return row.callHash;
  };
  return Object.assign(h, {
    store,
    pauseStore,
    owner,
    addUser(name: string, role: UserRole): Approver {
      const userId = newId("user");
      h.t.db
        .insert(users)
        .values({ id: userId, orgId: h.t.orgId, name, role, createdAt: h.clock.now })
        .run();
      return { orgId: h.t.orgId, userId, role };
    },
    decide(
      approvalId: string,
      intent: "approve" | "deny",
      opts: { by?: Approver; standing?: StandingChoice; callHash?: string } = {},
    ): DecideResult {
      return decideApproval(h.t.db, store, pauseStore, {
        approver: opts.by ?? owner,
        approvalId,
        callHash: opts.callHash ?? hashOf(approvalId),
        intent,
        standing: opts.standing ?? null,
        now: h.clock.now,
      });
    },
    status(approvalId: string): string {
      const row = h.t.db
        .select({ status: approvals.status })
        .from(approvals)
        .where(and(eq(approvals.orgId, h.t.orgId), eq(approvals.id, approvalId)))
        .get();
      if (row === undefined) throw new Error(`no approval ${approvalId}`);
      return row.status;
    },
    pause(key: PauseKey): void {
      pause(h.t.db, h.t.orgId, key, h.t.ownerId, h.clock.now);
    },
    resume(key: PauseKey): void {
      resume(h.t.db, h.t.orgId, key);
    },
  });
}

/** The approval id of a pending result; throws on anything else. */
export function pendingId(result: PipelineResult): string {
  if (result.status !== "pending") {
    throw new Error(`expected pending, got ${JSON.stringify(result)}`);
  }
  return result.approvalId;
}
