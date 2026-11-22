import { createHash } from "node:crypto";
import { and, count, eq, lt } from "drizzle-orm";
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
 * - Only the agent that parked a script can see or resume it, once.
 * - Resuming runs the parked call through the pipeline again: the approval
 *   decides it, never this table.
 * - A row lives as long as its approval and no longer; an agent keeps at
 *   most `MAX_PARKED_PER_AGENT`.
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
  calls: readonly ParkedCall[];
  modules: readonly StubModule[];
  /** The `parked` step's snapshot, base64. */
  snapshot: string;
}

/** Saves a parked script. Null when the agent already has its limit parked, or the approval is gone. */
export function parkScript(
  db: HeelDb,
  sealer: Sealer,
  input: ParkInput,
  now: Date,
): { id: string; expiresAt: Date } | null {
  return db.transaction((tx) => {
    tx.delete(parkedScripts)
      .where(and(eq(parkedScripts.agentId, input.agentId), lt(parkedScripts.expiresAt, now)))
      .run();
    const held =
      tx
        .select({ n: count() })
        .from(parkedScripts)
        .where(eq(parkedScripts.agentId, input.agentId))
        .get()?.n ?? 0;
    if (held >= MAX_PARKED_PER_AGENT) return null;
    const approval = tx
      .select({ expiresAt: approvals.expiresAt })
      .from(approvals)
      .where(and(eq(approvals.id, input.approvalId), eq(approvals.agentId, input.agentId)))
      .get();
    if (approval === undefined || approval.expiresAt <= now) return null;
    const id = newId("parkedScript");
    tx.insert(parkedScripts)
      .values({
        id,
        orgId: input.orgId,
        agentId: input.agentId,
        approvalId: input.approvalId,
        runId: input.runId ?? null,
        reason: input.reason ?? null,
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
    return { id, expiresAt: approval.expiresAt };
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
  calls: ParkedCall[];
  modulesHash: string;
  /** base64, as a worker's `start` takes it. */
  snapshot: string;
}

/**
 * Takes the agent's parked script out, once: the row is deleted in the same
 * step, so two resumes can't both run it. Null when it isn't there, has
 * expired, or its sealed bytes don't open.
 */
export function claimParked(
  db: HeelDb,
  sealer: Sealer,
  agent: { orgId: string; agentId: string },
  id: string,
  now: Date,
): ClaimedScript | null {
  const row = db.transaction((tx) =>
    tx
      .delete(parkedScripts)
      .where(
        and(
          eq(parkedScripts.id, id),
          eq(parkedScripts.orgId, agent.orgId),
          eq(parkedScripts.agentId, agent.agentId),
        ),
      )
      .returning()
      .get(),
  );
  if (row === undefined || row.expiresAt <= now) return null;
  let snapshot: Buffer;
  try {
    snapshot = sealer.openBytes(context(row.id, row.agentId), row.snapshot);
  } catch {
    return null;
  }
  return {
    approvalId: row.approvalId,
    runId: row.runId ?? undefined,
    reason: row.reason ?? undefined,
    calls: row.calls,
    modulesHash: row.modulesHash,
    snapshot: snapshot.toString("base64"),
  };
}
