import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { appendAudit } from "../../src/store/audit.ts";
import { MIGRATIONS_DIR, openStore } from "../../src/store/db.ts";
import { ensureInstall, ensureLocalOwner } from "../../src/store/install.ts";
import * as schema from "../../src/store/schema.ts";
import { auditLog } from "../../src/store/schema.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Migration 0003 rebuilds audit_log to widen its CHECK constraints. An
 * install upgrading from 0002 must keep every row and its id (the SIEM
 * cursor and export gap detection key on ids), and 0004 must put the
 * append-only triggers back.
 */

interface Journal {
  entries: { tag: string }[];
}

/** A copy of the migrations folder that stops after `lastTag`. */
function migrationsThrough(lastTag: string): string {
  const dir = join(tempDir(), "migrations");
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as Journal;
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
  expect(end).toBeGreaterThanOrEqual(0);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

function insertOldRow(sqlite: Database.Database, orgId: string, ownerId: string, at: number) {
  sqlite
    .prepare(
      `INSERT INTO audit_log (org_id, at, kind, agent_id, owner_id, surface, account, provider, tool, args, call_hash, reason)
       VALUES (?, ?, 'deny', 'agt_x', ?, 'mcp', 'gmail-work', 'gmail', 'send', '{}', 'h', 'no_rule_matched')`,
    )
    .run(orgId, at, ownerId);
}

describe("migration 0003/0004: audit_log rebuild", () => {
  it("I-73: keeps every row, its id and the append-only triggers", () => {
    const path = join(tempDir(), "heel.db");
    const old = new Database(path);
    old.pragma("foreign_keys = ON");
    // Only the orgs and users tables are touched before the upgrade, and 0002 has both.
    const oldDb = drizzle(old, { schema });
    migrate(oldDb, { migrationsFolder: migrationsThrough("0002_siem_cursors") });
    const { orgId } = ensureInstall(oldDb, new Date());
    const ownerId = ensureLocalOwner(oldDb, orgId, new Date());
    for (const at of [1, 2, 3]) insertOldRow(old, orgId, ownerId, at);
    const before = old.prepare("SELECT id, at, kind FROM audit_log ORDER BY id").all();
    old.close();

    const store = openStore(path);
    try {
      const after = store.sqlite.prepare("SELECT id, at, kind FROM audit_log ORDER BY id").all();
      expect(after).toEqual(before);

      // New ids continue after the copied ones.
      const call = {
        orgId,
        agentId: "agt_x",
        ownerId,
        surface: "mcp" as const,
        account: "gmail-work",
        provider: "gmail",
        tool: "send",
        args: {},
        items: 1,
      };
      const id = appendAudit(store.db, {
        kind: "would_ask",
        call,
        callHash: "h",
        rule: { name: null, file: "rules/owner.yaml", line: 3 },
      });
      expect(id).toBe(4);

      expect(() => store.db.update(auditLog).set({ reason: "x" }).run()).toThrow(/append-only/);
      expect(() => store.db.delete(auditLog).run()).toThrow(/append-only/);
      expect(store.sqlite.prepare("SELECT count(*) AS n FROM audit_log").get()).toEqual({ n: 4 });
    } finally {
      store.close();
    }
  });
});
