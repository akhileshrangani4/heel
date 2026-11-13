import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished } from "vitest";
import { type HeelDb, openStore, type Store } from "../../src/store/db.ts";
import { newId } from "../../src/store/ids.ts";
import { ensureInstall, ensureLocalOwner } from "../../src/store/install.ts";
import { accounts } from "../../src/store/schema.ts";

/** A private temp directory removed when the current test finishes. */
export function tempDir(prefix = "heel-test-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

export interface TestStore {
  dir: string;
  path: string;
  store: Store;
  db: HeelDb;
  orgId: string;
  ownerId: string;
}

/**
 * A file-backed store (so restarts can be simulated) with the install's org
 * and local owner created. Closed and deleted when the test finishes.
 */
export function testStore(dir: string = tempDir()): TestStore {
  const path = join(dir, "heel.db");
  const store = openStore(path);
  onTestFinished(() => {
    if (store.sqlite.open) store.close();
  });
  const now = new Date();
  const { orgId } = ensureInstall(store.db, now);
  const ownerId = ensureLocalOwner(store.db, orgId, now);
  return { dir, path, store, db: store.db, orgId, ownerId };
}

/** Reopens the same database file, as a heel restart would. */
export function reopen(previous: TestStore): TestStore {
  if (previous.store.sqlite.open) previous.store.close();
  const store = openStore(previous.path);
  onTestFinished(() => {
    if (store.sqlite.open) store.close();
  });
  return { ...previous, store, db: store.db };
}

export function addAccount(
  t: Pick<TestStore, "db" | "orgId" | "ownerId">,
  alias: string,
  provider: string,
): string {
  const id = newId("account");
  t.db
    .insert(accounts)
    .values({
      id,
      orgId: t.orgId,
      ownerId: t.ownerId,
      alias,
      provider,
      settings: {},
      status: "active",
      createdAt: new Date(),
    })
    .run();
  return id;
}
