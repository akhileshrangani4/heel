import { and, eq, inArray } from "drizzle-orm";
import { type Mode, strictest } from "../core/modes.ts";
import type { HeelDb, HeelTx } from "./db.ts";
import { modeChanges, modes } from "./schema.ts";

/**
 * Rollout modes in SQLite (A3). The org default is the row with an empty
 * `owner_id`; an owner may also have their own row. The pipeline reads the
 * mode once per call, inside its decision transaction, so a switch applies
 * from the next call on. Every switch is recorded in `mode_changes`.
 */

/** The org-wide default's `owner_id`. */
export const ORG_DEFAULT = "";

/** The mode for one owner's calls: the strictest row that applies, else `fallback`. */
export function modeFor(db: HeelDb | HeelTx, orgId: string, ownerId: string, fallback: Mode): Mode {
  const rows = db
    .select({ mode: modes.mode })
    .from(modes)
    .where(and(eq(modes.orgId, orgId), inArray(modes.ownerId, [ORG_DEFAULT, ownerId])))
    .all();
  return strictest(
    rows.map((row) => row.mode),
    fallback,
  );
}

/** The stored mode of one row (the org default, or one owner's), or null when unset. */
export function storedMode(db: HeelDb | HeelTx, orgId: string, ownerId: string): Mode | null {
  return (
    db
      .select({ mode: modes.mode })
      .from(modes)
      .where(and(eq(modes.orgId, orgId), eq(modes.ownerId, ownerId)))
      .get()?.mode ?? null
  );
}

/** Every stored row of an org. */
export function listModes(db: HeelDb, orgId: string) {
  return db.select().from(modes).where(eq(modes.orgId, orgId)).all();
}

/** Sets a row's mode and records the switch. Unset rows count as `enforce`. */
export function setMode(
  db: HeelDb,
  input: { orgId: string; ownerId: string; mode: Mode; by: string; at: Date },
): void {
  db.transaction((tx) => {
    const from = storedMode(tx, input.orgId, input.ownerId) ?? "enforce";
    tx.insert(modes)
      .values({
        orgId: input.orgId,
        ownerId: input.ownerId,
        mode: input.mode,
        setBy: input.by,
        setAt: input.at,
      })
      .onConflictDoUpdate({
        target: [modes.orgId, modes.ownerId],
        set: { mode: input.mode, setBy: input.by, setAt: input.at },
      })
      .run();
    tx.insert(modeChanges)
      .values({
        orgId: input.orgId,
        ownerId: input.ownerId,
        from,
        to: input.mode,
        changedBy: input.by,
        changedAt: input.at,
      })
      .run();
  });
}
