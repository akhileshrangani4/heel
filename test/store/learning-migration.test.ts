import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { describe, expect, it } from "vitest";
import { MIGRATIONS_DIR, openStore } from "../../src/store/db.ts";
import * as schema from "../../src/store/schema.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Migration 0032 adds `origin` to rule_proposals (roadmap 2.10). A
 * proposal made before it was an agent's, and must stay one.
 */

function migrationsThrough(lastTag: string): string {
  const dir = join(tempDir(), "migrations");
  cpSync(MIGRATIONS_DIR, dir, { recursive: true });
  const journalPath = join(dir, "meta/_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const end = journal.entries.findIndex((entry) => entry.tag === lastTag);
  expect(end).toBeGreaterThanOrEqual(0);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe("migration 0032: rule proposal origin", () => {
  it("keeps every proposal, each marked as its agent's", () => {
    const path = join(tempDir(), "heel.db");
    const old = new Database(path);
    old.pragma("foreign_keys = ON");
    migrate(drizzle(old, { schema }), {
      migrationsFolder: migrationsThrough("0031_background_scripts"),
    });
    old.prepare("INSERT INTO orgs (id, name, created_at) VALUES ('org', 'default', 0)").run();
    old
      .prepare(
        "INSERT INTO users (id, org_id, name, role, created_at) VALUES ('usr', 'org', 'owner', 'admin', 0)",
      )
      .run();
    old
      .prepare(
        "INSERT INTO agents (id, org_id, owner_id, name, created_at) VALUES ('agt', 'org', 'usr', 'bot', 0)",
      )
      .run();
    old
      .prepare(
        `INSERT INTO rule_proposals (id, org_id, owner_id, agent_id, rules, reason, status, created_at, expires_at)
         VALUES ('rp', 'org', 'usr', 'agt', '[]', 'why', 'pending', 0, 1)`,
      )
      .run();
    // A notification about it points at the proposal: rebuilding the table would break this.
    old
      .prepare(
        `INSERT INTO notification_deliveries (id, org_id, proposal_id, user_id, channel, target, status, next_attempt_at, created_at)
         VALUES ('nd', 'org', 'rp', 'usr', 'email', 'me@example.com', 'sent', 0, 0)`,
      )
      .run();
    old.close();

    const store = openStore(path);
    try {
      expect(
        store.sqlite.prepare("SELECT id, reason, status, origin FROM rule_proposals").all(),
      ).toEqual([{ id: "rp", reason: "why", status: "pending", origin: "agent" }]);
      expect(store.sqlite.prepare("SELECT proposal_id FROM notification_deliveries").all()).toEqual(
        [{ proposal_id: "rp" }],
      );
      // The new column holds only what heel writes.
      expect(() =>
        store.sqlite.prepare("UPDATE rule_proposals SET origin = 'someone'").run(),
      ).toThrow(/CHECK/);
    } finally {
      store.close();
    }
  });
});
