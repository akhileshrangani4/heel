import { and, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import {
  type ApprovalStatusView,
  type ApprovalTtls,
  DEFAULT_APPROVAL_TTLS,
  type DecisionIntent,
  type DecisionRefusal,
  decisionRefusal,
  governingOutcome,
  isStandingDuration,
  STANDING_DURATIONS,
  STANDING_MAX_MS,
  type StandingDuration,
  standingCovers,
  statusAt,
} from "../core/approvals.ts";
import type { Call, PauseScope } from "../core/call.ts";
import type { StandingApprovals } from "../core/rules/evaluate.ts";
import type {
  ApprovalRequest,
  ApprovalStore,
  GoverningApproval,
  HeelQuery,
  PauseStore,
} from "../gateway/pipeline/ports.ts";
import { appendAudit } from "./audit.ts";
import type { HeelDb } from "./db.ts";
import { newId } from "./ids.ts";
import {
  accounts,
  agents,
  approvals,
  type StandingScope,
  standingApprovals,
  type UserRole,
  users,
} from "./schema.ts";
import { accountApproverIds } from "./sharing.ts";

export type ApprovalRow = typeof approvals.$inferSelect;
export type StandingRow = typeof standingApprovals.$inferSelect;

/** The signed-in person deciding or viewing requests. */
export interface Approver {
  orgId: string;
  userId: string;
  role: UserRole;
}

/**
 * Approval requests and standing approvals in SQLite (spec: Approvals,
 * standing approvals and pause). The pipeline side (`ApprovalStore`) runs
 * inside the decision transaction it is handed; the human side runs its own
 * `BEGIN IMMEDIATE` transactions so a decision and a re-send never interleave.
 */
export class SqliteApprovalStore implements ApprovalStore {
  readonly ttls: ApprovalTtls;

  constructor(ttls: ApprovalTtls = DEFAULT_APPROVAL_TTLS) {
    this.ttls = ttls;
  }

  governing(db: HeelQuery, orgId: string, hash: string, now: Date): GoverningApproval | null {
    // The newest request for this call that could still govern. At most one
    // is pending (unique index), and nothing newer can be created while it
    // governs, so the newest live row is the only candidate.
    const row = db
      .select()
      .from(approvals)
      .where(
        and(
          eq(approvals.orgId, orgId),
          eq(approvals.callHash, hash),
          inArray(approvals.status, ["pending", "approved", "denied"]),
        ),
      )
      .orderBy(desc(approvals.createdAt), desc(sql`rowid`))
      .get();
    if (row === undefined) return null;
    const outcome = governingOutcome(row, now);
    switch (outcome.kind) {
      case "none":
        return null;
      case "settle_expired":
        // Reported once as expired (I-55); the next identical call starts a new request.
        db.update(approvals).set({ status: "expired" }).where(eq(approvals.id, row.id)).run();
        return { id: row.id, status: "expired", ruleHash: row.ruleHash };
      case "govern":
        return { id: row.id, status: outcome.status, ruleHash: row.ruleHash };
    }
  }

  request(db: HeelQuery, input: ApprovalRequest, now: Date): string {
    const id = newId("approval");
    const { call } = input;
    db.insert(approvals)
      .values({
        id,
        orgId: call.orgId,
        agentId: call.agentId,
        ownerId: call.ownerId,
        runId: call.runId ?? null,
        callHash: input.callHash,
        account: call.account,
        tool: call.tool,
        call,
        origin: input.origin,
        rule: input.rule,
        ruleHash: input.ruleHash,
        reason: input.reason,
        client: input.client,
        status: "pending",
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.ttls.pendingMs),
      })
      .run();
    return id;
  }

  consume(db: HeelQuery, approvalId: string, now: Date): void {
    const result = db
      .update(approvals)
      .set({ status: "executed", executedAt: now })
      .where(
        and(
          eq(approvals.id, approvalId),
          eq(approvals.status, "approved"),
          gt(approvals.expiresAt, now),
        ),
      )
      .run();
    // Executes once (I-54): anything but exactly one approved row fails the decision closed.
    if (result.changes !== 1) throw new Error(`approval ${approvalId} is no longer approved`);
  }

  standing(db: HeelQuery, call: Call, hash: string, now: Date): StandingApprovals {
    const rows = db
      .select()
      .from(standingApprovals)
      .where(
        and(
          eq(standingApprovals.orgId, call.orgId),
          eq(standingApprovals.agentId, call.agentId),
          isNull(standingApprovals.revokedAt),
          gt(standingApprovals.expiresAt, now),
        ),
      )
      .orderBy(standingApprovals.createdAt)
      .all();
    if (rows.length === 0) return { find: () => null };
    return {
      // The evaluator asks only for the owner rule that matched and would
      // ask, so a standing approval sits just above its parent rule and can
      // only turn that ask into allow (I-14, I-15). It binds to the rule's
      // content hash: an edited or deleted rule never matches it (I-16).
      find: (rule) => {
        const row = rows.find((r) =>
          standingCovers(r, {
            agentId: call.agentId,
            ruleHash: rule.hash,
            callHash: () => hash,
            runId: call.runId,
            account: call.account,
            repo: call.repo,
          }),
        );
        return row === undefined ? null : { id: row.id };
      },
    };
  }
}

// ── reads for the human plane and check-back ────────────────────────────────

/** The name of the user a column points at, as a correlated subquery. */
function userNameOf(column: SQLiteColumn) {
  return sql<string | null>`(select name from users where users.id = ${column})`;
}

/** A request as the approval page and the pending list show it. */
export interface ApprovalRecord {
  row: ApprovalRow;
  status: ApprovalStatusView;
  agentName: string;
  decidedByName: string | null;
}

export function getApproval(
  db: HeelQuery,
  orgId: string,
  approvalId: string,
  now: Date,
): ApprovalRecord | null {
  const found = db
    .select({
      row: approvals,
      agentName: agents.name,
      decidedByName: userNameOf(approvals.decidedBy),
    })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(and(eq(approvals.orgId, orgId), eq(approvals.id, approvalId)))
    .get();
  if (found === undefined) return null;
  return { ...found, status: statusAt(found.row, now) };
}

/**
 * Read-only check-back for the agent that made the request (spec: Pending,
 * joining and checking back). Another agent's request reads as unknown, so
 * ids can't be probed across agents. Never executes anything.
 */
export function approvalStatusForAgent(
  db: HeelQuery,
  agent: { orgId: string; agentId: string },
  approvalId: string,
  now: Date,
): ApprovalStatusView | null {
  const row = db
    .select({ status: approvals.status, expiresAt: approvals.expiresAt })
    .from(approvals)
    .where(
      and(
        eq(approvals.orgId, agent.orgId),
        eq(approvals.id, approvalId),
        eq(approvals.agentId, agent.agentId),
      ),
    )
    .get();
  return row === undefined ? null : statusAt(row, now);
}

/**
 * The user ids allowed to decide a request (D13b; spec: Teams, "Approvers"):
 * admins for an org ask; otherwise the account's approvers for the call's
 * repo, its general approvers, or its owner. An admin who isn't one of them
 * can't decide an account's ask.
 */
export function approverIds(
  db: HeelQuery,
  row: Pick<ApprovalRow, "orgId" | "account" | "origin"> & { call: Pick<Call, "repo"> },
): string[] {
  if (row.origin === "org") {
    return db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.orgId, row.orgId), eq(users.role, "admin"), isNull(users.disabledAt)))
      .all()
      .map((u) => u.id);
  }
  return accountApproverIds(db, row.orgId, row.account, row.call.repo);
}

/** Every request in the org from the last day, newest first: the admin socket's view. */
export function listOrgApprovals(db: HeelQuery, orgId: string, now: Date): ApprovalRecord[] {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return db
    .select({
      row: approvals,
      agentName: agents.name,
      decidedByName: userNameOf(approvals.decidedBy),
    })
    .from(approvals)
    .innerJoin(agents, eq(agents.id, approvals.agentId))
    .where(and(eq(approvals.orgId, orgId), gt(approvals.expiresAt, since)))
    .orderBy(desc(approvals.createdAt), desc(sql`approvals.rowid`))
    .all()
    .map((found) => ({ ...found, status: statusAt(found.row, now) }));
}

/** Requests this person may decide, newest first, including ones decided in the last day. */
export function listApprovalsFor(db: HeelQuery, approver: Approver, now: Date): ApprovalRecord[] {
  const approversByScope = new Map<string, string[]>();
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  return (
    db
      .select({
        row: approvals,
        agentName: agents.name,
        decidedByName: userNameOf(approvals.decidedBy),
      })
      .from(approvals)
      .innerJoin(agents, eq(agents.id, approvals.agentId))
      .where(and(eq(approvals.orgId, approver.orgId), gt(approvals.expiresAt, since)))
      .orderBy(desc(approvals.createdAt), desc(sql`approvals.rowid`))
      .all()
      // One approver lookup per account and repo, not per request.
      .filter(({ row }) => {
        const key = `${row.origin} ${row.account} ${row.call.repo ?? ""}`;
        let ids = approversByScope.get(key);
        if (ids === undefined) {
          ids = approverIds(db, row);
          approversByScope.set(key, ids);
        }
        return ids.includes(approver.userId);
      })
      .map((found) => ({ ...found, status: statusAt(found.row, now) }))
  );
}

// ── deciding ────────────────────────────────────────────────────────────────

export interface StandingChoice {
  scope: StandingScope;
  duration: StandingDuration;
}

export interface DecideInput {
  approver: Approver;
  approvalId: string;
  /** The call hash the passkey assertion was bound to; must still match the request. */
  callHash: string;
  intent: DecisionIntent;
  /** Set for "approve as standing". */
  standing: StandingChoice | null;
  now: Date;
}

export type DecideResult =
  | { ok: true; status: "approved" | "denied"; standingApprovalId: string | null }
  | { ok: false; reason: DecisionRefusal | "not_found" | "hash_mismatch"; pauseScope?: PauseScope };

/**
 * Records a person's decision (spec: Approvals). Approving runs nothing
 * (I-53): it only lets the agent's identical re-send execute once. The whole
 * check-and-write runs in one `BEGIN IMMEDIATE` transaction with the pause
 * check, so a pause and an approval can't cross (I-61).
 */
export function decideApproval(
  db: HeelDb,
  store: SqliteApprovalStore,
  pauses: PauseStore,
  input: DecideInput,
): DecideResult {
  return db.transaction(
    (tx): DecideResult => {
      const { approver, now } = input;
      const row = tx
        .select()
        .from(approvals)
        .where(and(eq(approvals.orgId, approver.orgId), eq(approvals.id, input.approvalId)))
        .get();
      if (row === undefined) return { ok: false, reason: "not_found" };
      if (row.callHash !== input.callHash) return { ok: false, reason: "hash_mismatch" };
      const call = row.call;
      const pauseScope = pauses.find(tx, {
        orgId: call.orgId,
        agentId: call.agentId,
        ownerId: call.ownerId,
        account: call.account,
        provider: call.provider,
      });
      const refusal = decisionRefusal({
        intent: input.intent,
        standing: input.standing !== null,
        runScoped: input.standing?.scope === "run",
        runId: row.runId,
        status: statusAt(row, now),
        origin: row.origin,
        paused: pauseScope !== null,
        isApprover: approverIds(tx, row).includes(approver.userId),
      });
      if (refusal !== null) {
        return {
          ok: false,
          reason: refusal,
          ...(refusal === "paused" && pauseScope !== null && { pauseScope }),
        };
      }

      if (input.intent === "deny") {
        // Keeps its original deadline: re-sends read `denied` until the pending TTL ends (Q-A5).
        tx.update(approvals)
          .set({ status: "denied", decidedAt: now, decidedBy: approver.userId })
          .where(eq(approvals.id, row.id))
          .run();
        appendAudit(
          tx,
          {
            kind: "approval_denied",
            call,
            callHash: row.callHash,
            approvalId: row.id,
            approverId: approver.userId,
          },
          now,
        );
        return { ok: true, status: "denied", standingApprovalId: null };
      }

      tx.update(approvals)
        .set({
          status: "approved",
          decidedAt: now,
          decidedBy: approver.userId,
          expiresAt: new Date(now.getTime() + store.ttls.approvedMs),
        })
        .where(eq(approvals.id, row.id))
        .run();
      const standingApprovalId =
        input.standing === null ? null : grantStanding(tx, row, input.standing, approver, now);
      appendAudit(
        tx,
        {
          kind: "approved",
          call,
          callHash: row.callHash,
          approvalId: row.id,
          approverId: approver.userId,
          ...(standingApprovalId !== null && { standingApprovalId }),
        },
        now,
      );
      return { ok: true, status: "approved", standingApprovalId };
    },
    { behavior: "immediate" },
  );
}

/** The longest a run-scoped standing approval lasts (A4a). */
export const RUN_SCOPE_MAX_MS = 24 * 60 * 60_000;

function grantStanding(
  tx: HeelQuery,
  row: ApprovalRow,
  choice: StandingChoice,
  approver: Approver,
  now: Date,
): string {
  // A run grant needs the run it names; without one it would match nothing.
  if (choice.scope === "run" && row.runId === null) {
    throw new TypeError("a run-scoped standing approval needs a request with a run id");
  }
  // Callers validate the choice; this keeps a bad value from writing an invalid expiry.
  if (!isStandingDuration(choice.duration)) {
    throw new TypeError(`not a standing duration: ${String(choice.duration)}`);
  }
  const id = newId("standingApproval");
  // A run id is the agent's own word, and it can reuse one; a run grant
  // lasts at most a day however long the person picked.
  const durationMs = Math.min(
    STANDING_DURATIONS[choice.duration],
    choice.scope === "run" ? RUN_SCOPE_MAX_MS : STANDING_MAX_MS,
  );
  tx.insert(standingApprovals)
    .values({
      id,
      orgId: row.orgId,
      agentId: row.agentId,
      approvalId: row.id,
      scope: choice.scope,
      callHash: choice.scope === "exact_call" ? row.callHash : null,
      runId: choice.scope === "run" ? row.runId : null,
      account: row.account,
      repo: row.call.repo ?? null,
      rule: row.rule,
      ruleHash: row.ruleHash,
      createdBy: approver.userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + durationMs),
    })
    .run();
  return id;
}

// ── standing approvals for the human plane ──────────────────────────────────

export interface StandingRecord {
  row: StandingRow;
  agentName: string;
  account: string;
  /** The action or tool an exact-call approval covers. */
  covers: string;
  createdByName: string;
  revokedByName: string | null;
  ownerId: string;
  /** The call whose approval granted it, for pause checks. */
  call: Call;
}

/** Every standing approval in the org, newest first; callers filter by who may see it. */
export function listStanding(db: HeelQuery, orgId: string): StandingRecord[] {
  return db
    .select({
      row: standingApprovals,
      agentName: agents.name,
      account: approvals.account,
      call: approvals.call,
      createdByName: userNameOf(standingApprovals.createdBy),
      revokedByName: userNameOf(standingApprovals.revokedBy),
      ownerId: agents.ownerId,
    })
    .from(standingApprovals)
    .innerJoin(agents, eq(agents.id, standingApprovals.agentId))
    .innerJoin(approvals, eq(approvals.id, standingApprovals.approvalId))
    .where(eq(standingApprovals.orgId, orgId))
    .orderBy(desc(standingApprovals.createdAt))
    .all()
    .map(({ call, createdByName, ...rest }) => ({
      ...rest,
      call,
      covers: call.action ?? call.tool,
      createdByName: createdByName ?? "unknown",
    }));
}

export type RevokeResult = { ok: true } | { ok: false; reason: "not_found" | "already_revoked" };

/** Revoking only tightens, so it needs no passkey; it takes effect on the next call. */
export function revokeStanding(
  db: HeelQuery,
  orgId: string,
  standingId: string,
  revokedBy: string | null,
  now: Date,
): RevokeResult {
  const result = db
    .update(standingApprovals)
    .set({ revokedAt: now, revokedBy })
    .where(
      and(
        eq(standingApprovals.orgId, orgId),
        eq(standingApprovals.id, standingId),
        isNull(standingApprovals.revokedAt),
      ),
    )
    .run();
  if (result.changes === 1) return { ok: true };
  const exists = db
    .select({ id: standingApprovals.id })
    .from(standingApprovals)
    .where(and(eq(standingApprovals.orgId, orgId), eq(standingApprovals.id, standingId)))
    .get();
  return { ok: false, reason: exists === undefined ? "not_found" : "already_revoked" };
}
