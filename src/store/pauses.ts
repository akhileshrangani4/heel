import { and, eq, or } from "drizzle-orm";
import type { PauseScope } from "../core/call.ts";
import type { HeelQuery, PauseStore, PauseTarget } from "../gateway/pipeline/ports.ts";
import { pauses } from "./schema.ts";

export type PauseRow = typeof pauses.$inferSelect;

/** What one pause covers. `target` is "" for global, else an agent id, owner id, account alias or provider. */
export interface PauseKey {
  scope: PauseScope;
  target: string;
}

/** Reported in this order when several pauses cover a call: the broadest first. */
const SCOPE_ORDER: readonly PauseScope[] = ["global", "owner", "agent", "account", "provider"];

/** Pure: the broadest scope among the pauses that cover a call. */
export function broadestScope(scopes: readonly PauseScope[]): PauseScope | null {
  return SCOPE_ORDER.find((scope) => scopes.includes(scope)) ?? null;
}

/**
 * Pause state in SQLite (spec: Pause). A row means "paused"; resume deletes
 * it, so state survives a restart (I-04). The pipeline asks inside its
 * decision transaction, before the rules and again when an approved call
 * re-runs (I-60).
 */
export class SqlitePauseStore implements PauseStore {
  find(db: HeelQuery, target: PauseTarget): PauseScope | null {
    const rows = db
      .select({ scope: pauses.scope })
      .from(pauses)
      .where(
        and(
          eq(pauses.orgId, target.orgId),
          or(
            eq(pauses.scope, "global"),
            and(eq(pauses.scope, "owner"), eq(pauses.target, target.ownerId)),
            and(eq(pauses.scope, "agent"), eq(pauses.target, target.agentId)),
            and(eq(pauses.scope, "account"), eq(pauses.target, target.account)),
            and(eq(pauses.scope, "provider"), eq(pauses.target, target.provider)),
          ),
        ),
      )
      .all();
    return broadestScope(rows.map((r) => r.scope));
  }
}

/**
 * Pauses one scope. Idempotent: pausing what is already paused keeps the
 * original row (and who paused it) and reports `created: false`.
 */
export function pause(
  db: HeelQuery,
  orgId: string,
  key: PauseKey,
  pausedBy: string,
  now: Date,
): { created: boolean } {
  const result = db
    .insert(pauses)
    .values({ orgId, scope: key.scope, target: key.target, pausedBy, pausedAt: now })
    .onConflictDoNothing()
    .run();
  return { created: result.changes === 1 };
}

/** Lifts one pause. Nothing paused while it stood is replayed (I-63). */
export function resume(db: HeelQuery, orgId: string, key: PauseKey): { removed: boolean } {
  const result = db
    .delete(pauses)
    .where(and(eq(pauses.orgId, orgId), eq(pauses.scope, key.scope), eq(pauses.target, key.target)))
    .run();
  return { removed: result.changes === 1 };
}

export function findPause(db: HeelQuery, orgId: string, key: PauseKey): PauseRow | null {
  return (
    db
      .select()
      .from(pauses)
      .where(
        and(eq(pauses.orgId, orgId), eq(pauses.scope, key.scope), eq(pauses.target, key.target)),
      )
      .get() ?? null
  );
}

export function listPauses(db: HeelQuery, orgId: string): PauseRow[] {
  return db.select().from(pauses).where(eq(pauses.orgId, orgId)).orderBy(pauses.pausedAt).all();
}
