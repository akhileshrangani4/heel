import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.ts";

export type HeelDb = BetterSQLite3Database<typeof schema>;
/** The handle inside `db.transaction((tx) => …)`. */
export type HeelTx = Parameters<Parameters<HeelDb["transaction"]>[0]>[0];

export interface Store {
  db: HeelDb;
  /** The raw handle, for `BEGIN IMMEDIATE` transactions and pragmas. */
  sqlite: Database.Database;
  close(): void;
}

export const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

/**
 * Opens (creating if needed) heel's SQLite file and applies migrations.
 *
 * The file is created mode 0600 before SQLite touches it: credentials are
 * encrypted, but approvals and audit rows hold call arguments. SQLite gives
 * its -wal and -shm files the same mode as the database file.
 */
export function openStore(path: string): Store {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
  }
  const sqlite = new Database(path);
  try {
    // WAL keeps readers off the writer; FULL sync makes a committed count or
    // audit row survive power loss, not just a process crash (I-04).
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma("synchronous = FULL");
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma("busy_timeout = 5000");
    const db = drizzle(sqlite, { schema });
    migrate(db, { migrationsFolder: MIGRATIONS_DIR });
    return { db, sqlite, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}
