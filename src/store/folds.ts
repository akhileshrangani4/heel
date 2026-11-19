import { and, eq } from "drizzle-orm";
import type { HeelDb } from "./db.ts";
import { foldPreferences } from "./schema.ts";

/**
 * Remembered folds on the approval page: per person and kind of request,
 * which collapsible sections they keep open. Presentation only.
 */

/** Kinds and section ids the page sends: short, printable, no markup. */
const NAME = /^[A-Za-z0-9._:@+-]{1,120}$/;

export function isFoldName(value: string): boolean {
  return NAME.test(value);
}

/** A person's remembered sections for one kind, as section id → open. */
export function foldsFor(db: HeelDb, userId: string, kind: string): ReadonlyMap<string, boolean> {
  const rows = db
    .select({ section: foldPreferences.section, open: foldPreferences.open })
    .from(foldPreferences)
    .where(and(eq(foldPreferences.userId, userId), eq(foldPreferences.kind, kind)))
    .all();
  return new Map(rows.map((row) => [row.section, row.open]));
}

/** Remembers one section's state; the latest toggle wins. */
export function rememberFold(
  db: HeelDb,
  input: { userId: string; kind: string; section: string; open: boolean },
  at: Date,
): void {
  db.insert(foldPreferences)
    .values({ ...input, updatedAt: at })
    .onConflictDoUpdate({
      target: [foldPreferences.userId, foldPreferences.kind, foldPreferences.section],
      set: { open: input.open, updatedAt: at },
    })
    .run();
}
