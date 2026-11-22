import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openStore } from "../../src/store/db.ts";
import { ruleChanges, ruleFileSnapshots } from "../../src/store/schema.ts";
import { MASTER_KEY_ENV } from "../../src/vault/key.ts";
import { boot, configIn, newKey } from "../helpers/serve.ts";
import { tempDir } from "../helpers/store.ts";

/** Roadmap 2.4 in a running heel: an edit made outside heel lands in the history. */
describe("rule history in a running heel", () => {
  it("remembers the rules at start, and records an edit the watcher reloads", async () => {
    const home = tempDir("heel-history-serve-");
    mkdirSync(join(home, "rules"));
    const file = join(home, "rules", "owner.yaml");
    writeFileSync(file, "rules:\n  - match: {}\n    then: ask\n");
    const config = configIn(home);
    await boot(config, { [MASTER_KEY_ENV]: newKey() });
    const store = openStore(config.databasePath);
    try {
      expect(
        store.db
          .select()
          .from(ruleFileSnapshots)
          .all()
          .map((s) => s.file),
      ).toEqual(["rules/owner.yaml"]);
      writeFileSync(file, "rules:\n  - match: {}\n    then: deny\n");
      let changes = store.db.select().from(ruleChanges).all();
      for (let i = 0; i < 100 && changes.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        changes = store.db.select().from(ruleChanges).all();
      }
      expect(changes).toMatchObject([{ source: "outside", file: "rules/owner.yaml" }]);
    } finally {
      store.close();
    }
  }, 15_000);
});
