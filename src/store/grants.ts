import { and, desc, eq, gt, isNull } from "drizzle-orm";
import type { HeelDb, HeelTx } from "./db.ts";
import { newId } from "./ids.ts";
import { grants } from "./schema.ts";

/**
 * Intent grants in SQLite (A4b). The pipeline reads an agent's live grants
 * inside its decision transaction; revoking one applies from the next call.
 */

export type GrantRow = typeof grants.$inferSelect;

/** An agent's grants that are neither expired nor revoked, oldest first. */
export function liveGrants(
  db: HeelDb | HeelTx,
  orgId: string,
  agentId: string,
  now: Date,
): GrantRow[] {
  return db
    .select()
    .from(grants)
    .where(
      and(
        eq(grants.orgId, orgId),
        eq(grants.agentId, agentId),
        isNull(grants.revokedAt),
        gt(grants.expiresAt, now),
      ),
    )
    .orderBy(grants.createdAt)
    .all();
}

export function createGrant(
  db: HeelDb,
  input: {
    orgId: string;
    agentId: string;
    task: string;
    match: string;
    by: string;
    now: Date;
    expiresAt: Date;
  },
): string {
  const id = newId("grant");
  db.insert(grants)
    .values({
      id,
      orgId: input.orgId,
      agentId: input.agentId,
      task: input.task,
      match: input.match,
      createdBy: input.by,
      createdAt: input.now,
      expiresAt: input.expiresAt,
    })
    .run();
  return id;
}

/** Every grant of an org, newest first. */
export function listGrants(db: HeelDb, orgId: string): GrantRow[] {
  return db
    .select()
    .from(grants)
    .where(eq(grants.orgId, orgId))
    .orderBy(desc(grants.createdAt))
    .all();
}

export function revokeGrant(db: HeelDb, orgId: string, id: string, by: string, now: Date): boolean {
  const result = db
    .update(grants)
    .set({ revokedAt: now, revokedBy: by })
    .where(and(eq(grants.orgId, orgId), eq(grants.id, id), isNull(grants.revokedAt)))
    .run();
  return result.changes > 0;
}
