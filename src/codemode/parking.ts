import { createHash } from "node:crypto";
import { and, count, eq, lte } from "drizzle-orm";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { approvals, type ParkedCall, parkedScripts } from "../store/schema.ts";
import type { StubModule } from "./stubs.ts";

/**
 * Parked code-mode scripts (code mode round 2, C2). When a call in a script
 * asks for approval, heel saves the suspended script here instead of ending
 * it; once the approval is decided the agent sends `run_code({ resume })`
 * and the script carries on from that call.
 *
 * - The snapshot holds what the script already read, so it's sealed with
 *   the vault's key and bound to its row and agent.
 * - Only the agent that parked a script can see or resume it, once: the
 *   row goes when the script is restored at its call, not before.
 * - Resuming runs the parked call through the pipeline again: the approval
 *   decides it, never this table.
 * - A row lives as long as its approval and no longer (`purgeExpiredParked`
 *   runs on every `run_code` and at start); an agent keeps at most
 *   `MAX_PARKED_PER_AGENT` waiting on undecided approvals.
 */

export const MAX_PARKED_PER_AGENT = 5;

/** Seals and opens a parked script's bytes; the vault's `sealBytes`/`openBytes`. */
export interface Sealer {
  sealBytes(context: string, plaintext: Buffer): Buffer;
  openBytes(context: string, sealed: Buffer): Buffer;
}

const context = (id: string, agentId: string) => `parked-script:${id}:${agentId}`;

/** Pure: a hash of the modules a script runs against: their names, stubs and functions. */
export function modulesHash(modules: readonly StubModule[]): string {
  const shape = modules
    .map((m) => [m.module, m.stubs, [...m.functions].sort()] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  return createHash("sha256").update(JSON.stringify(shape)).digest("hex");
}

export interface ParkInput {
  orgId: string;
  agentId: string;
  approvalId: string;
  runId: string | undefined;
  reason: string | undefined;
  /** The script's code, kept so a later ask in the resumed script still shows it. */
  code: string;
  calls: readonly ParkedCall[];
  modules: readonly StubModule[];
  /** The `parked` step's snapshot, base64. */
  snapshot: string;
}

/** Deletes every parked script whose approval has expired, whatever agent parked it. */
export function purgeExpiredParked(db: HeelDb, now: Date): void {
  db.delete(parkedScripts).where(lte(parkedScripts.expiresAt, now)).run();
}

export type ParkOutcome =
  | { ok: true; id: string; expiresAt: Date }
  | { ok: false; reason: "limit" | "approval_gone" };

/**
 * Saves a parked script. Refused when the agent already has its limit of
 * scripts waiting on undecided approvals (decided ones don't count: they
 * wait only for the agent), or when the approval is gone.
 */
export function parkScript(db: HeelDb, sealer: Sealer, input: ParkInput, now: Date): ParkOutcome {
  return db.transaction((tx): ParkOutcome => {
    tx.delete(parkedScripts).where(lte(parkedScripts.expiresAt, now)).run();
    const waiting =
      tx
        .select({ n: count() })
        .from(parkedScripts)
        .innerJoin(approvals, eq(approvals.id, parkedScripts.approvalId))
        .where(and(eq(parkedScripts.agentId, input.agentId), eq(approvals.status, "pending")))
        .get()?.n ?? 0;
    if (waiting >= MAX_PARKED_PER_AGENT) return { ok: false, reason: "limit" };
    const approval = tx
      .select({ expiresAt: approvals.expiresAt })
      .from(approvals)
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.agentId, input.agentId)))
      .get();
    if (approval === undefined || approval.expiresAt <= now)
      return { ok: false, reason: "approval_gone" };
    const id = newId("parkedScript");
    tx.insert(parkedScripts)
      .values({
        id,
        orgId: input.orgId,
        agentId: input.agentId,
        approvalId: input.approvalId,
        runId: input.runId ?? null,
        reason: input.reason ?? null,
        code: input.code,
        calls: [...input.calls],
        modulesHash: modulesHash(input.modules),
        snapshot: sealer.sealBytes(
          context(id, input.agentId),
          Buffer.from(input.snapshot, "base64"),
        ),
        createdAt: now,
        expiresAt: approval.expiresAt,
      })
      .run();
    return { ok: true, id, expiresAt: approval.expiresAt };
  });
}

export interface ParkedView {
  id: string;
  approvalId: string;
}

/** The agent's parked script, if it's still there; claims nothing, opens nothing. */
export function findParked(
  db: HeelDb,
  agent: { orgId: string; agentId: string },
  id: string,
  now: Date,
): ParkedView | null {
  const row = db
    .select({
      id: parkedScripts.id,
      approvalId: parkedScripts.approvalId,
      expiresAt: parkedScripts.expiresAt,
    })
    .from(parkedScripts)
    .where(
      and(
        eq(parkedScripts.id, id),
        eq(parkedScripts.orgId, agent.orgId),
        eq(parkedScripts.agentId, agent.agentId),
      ),
    )
    .get();
  return row === undefined || row.expiresAt <= now
    ? null
    : { id: row.id, approvalId: row.approvalId };
}

export interface ClaimedScript {
  approvalId: string;
  runId: string | undefined;
  reason: string | undefined;
  code: string;
  calls: ParkedCall[];
  modulesHash: string;
  /** base64, as a worker's `start` takes it. */
  snapshot: string;
}

/**
 * Reads and opens the agent's parked script without removing it, so a
 * resume that fails before the script is restored (a hung-up client, a
 * worker that doesn't start) leaves it to try again. `releaseParked` removes
 * it once the script is back at its call. Null when it isn't there, has
 * expired, or its sealed bytes don't open.
 */
export function openParked(
  db: HeelDb,
  sealer: Sealer,
  agent: { orgId: string; agentId: string },
  id: string,
  now: Date,
): (ClaimedScript & { id: string }) | null {
  const row = db
    .select()
    .from(parkedScripts)
    .where(
      and(
        eq(parkedScripts.id, id),
        eq(parkedScripts.orgId, agent.orgId),
        eq(parkedScripts.agentId, agent.agentId),
      ),
    )
    .get();
  if (row === undefined || row.expiresAt <= now) return null;
  let snapshot: Buffer;
  try {
    snapshot = sealer.openBytes(context(row.id, row.agentId), row.snapshot);
  } catch {
    return null;
  }
  return {
    id: row.id,
    approvalId: row.approvalId,
    runId: row.runId ?? undefined,
    reason: row.reason ?? undefined,
    code: row.code,
    calls: row.calls,
    modulesHash: row.modulesHash,
    snapshot: snapshot.toString("base64"),
  };
}

/**
 * Removes a parked script once it's been restored, so it resumes once:
 * false when another resume already took it.
 */
export function releaseParked(db: HeelDb, agent: { agentId: string }, id: string): boolean {
  const gone = db
    .delete(parkedScripts)
    .where(and(eq(parkedScripts.id, id), eq(parkedScripts.agentId, agent.agentId)))
    .returning({ id: parkedScripts.id })
    .get();
  return gone !== undefined;
}

/** The parked script waiting on an approval, if any: for the approval page. */
export function parkedFor(
  db: HeelDb,
  orgId: string,
  approvalId: string,
  now: Date,
): { id: string } | null {
  const row = db
    .select({ id: parkedScripts.id, expiresAt: parkedScripts.expiresAt })
    .from(parkedScripts)
    .where(and(eq(parkedScripts.orgId, orgId), eq(parkedScripts.approvalId, approvalId)))
    .get();
  return row === undefined || row.expiresAt <= now ? null : { id: row.id };
}

/**
 * Stops the script parked on an approval, from the approval page: it's
 * deleted, so the agent can't resume it. It only takes something away, so it
 * needs no passkey. How many it stopped (0 or 1).
 */
export function stopParked(db: HeelDb, orgId: string, approvalId: string): number {
  return db
    .delete(parkedScripts)
    .where(and(eq(parkedScripts.orgId, orgId), eq(parkedScripts.approvalId, approvalId)))
    .returning({ id: parkedScripts.id })
    .all().length;
}
