import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { rulesPaths } from "../../src/config/rules.ts";
import { RulesHolder } from "../../src/config/rules-reload.ts";
import { LOCAL_OWNER_NAME } from "../../src/store/install.ts";
import { oneRule, pipelineHarness } from "../helpers/pipeline.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * Fail-closed rows "A rules file is invalid at boot" and "... invalid on
 * reload" (spec: Fail-closed behavior; Rules, "Loading, testing and
 * reload"), with real files under a temporary `$HEEL_HOME` read through
 * D2's `RulesHolder`. At boot with no valid set, every call is denied; a
 * broken edit later keeps the last valid set deciding.
 */

const SEND = { args: { action: "email.send", recipients: ["bob@vendor.com"] } };
const MERGE = {
  account: "github",
  tool: "merge",
  args: { action: "github.merge", repo: "acme/web" },
};
const ALLOW_SENDS = oneRule("{ action: email.send }");

function rulesHome() {
  const home = tempDir("heel-rules-");
  mkdirSync(join(home, "rules"));
  const paths = rulesPaths(home);
  return {
    holder: new RulesHolder(paths),
    writeOwner: (text: string) =>
      writeFileSync(join(paths.ownersDir, `${LOCAL_OWNER_NAME}.yaml`), text),
    writeOrg: (text: string) => writeFileSync(paths.orgFile, text),
  };
}

const CORRUPT_OWNER_FILES: [string, string][] = [
  ["unparseable YAML", "rules: [\n  - match: { action: email.send"],
  ["an unknown decision", "rules:\n  - match: { action: email.send }\n    then: maybe\n"],
  ["an unknown match key", "rules:\n  - match: { acount: gmail-work }\n    then: allow\n"],
  ["a duplicate key", "rules:\n  - match: {}\n    then: deny\n    then: allow\n"],
  ["binary garbage", "\u0000\u0001\u0002rules\u00ff"],
];

describe("fail closed: the rules files", () => {
  it.each(CORRUPT_OWNER_FILES)(
    "denies every call when the owner file has %s at boot",
    async (_label, text) => {
      const files = rulesHome();
      files.writeOwner(text);
      expect(files.holder.reload()).toMatchObject({ ok: false, keptLastGood: false });
      const h = pipelineHarness({ rulesSource: files.holder });

      const send = await h.call(SEND);
      const merge = await h.call(MERGE);

      expect(send).toMatchObject({ status: "denied", reason: "rules_unavailable" });
      expect(merge).toMatchObject({ status: "denied", reason: "rules_unavailable" });
      expect(h.provider.executed).toEqual([]);
      expect(h.counts()).toEqual([]);
      expect(h.audit().map((row) => [row.kind, row.reason])).toEqual([
        ["deny", "rules_unavailable"],
        ["deny", "rules_unavailable"],
      ]);
    },
  );

  it("denies every call when the org file tries to allow, even with a valid owner file (I-12)", async () => {
    const files = rulesHome();
    files.writeOrg(oneRule("{}", "allow"));
    files.writeOwner(ALLOW_SENDS);
    expect(files.holder.reload().ok).toBe(false);
    const h = pipelineHarness({ rulesSource: files.holder });

    expect(await h.call(SEND)).toMatchObject({ status: "denied", reason: "rules_unavailable" });
    expect(h.provider.executed).toEqual([]);
  });

  it("keeps the last valid set deciding when an edit corrupts the file, and swaps in the fix", async () => {
    const files = rulesHome();
    files.writeOwner(ALLOW_SENDS);
    expect(files.holder.reload().ok).toBe(true);
    const h = pipelineHarness({ rulesSource: files.holder });
    expect((await h.call(SEND)).status).toBe("allowed");

    // A broken save: the set in force doesn't change, in either direction.
    files.writeOwner("rules: [\n  - match: {}\n    then: allow");
    expect(files.holder.reload()).toMatchObject({ ok: false, keptLastGood: true });
    expect((await h.call(SEND)).status).toBe("allowed");
    expect(await h.call(MERGE)).toMatchObject({ status: "denied", rule: null });

    // The fix lands, and it now decides.
    files.writeOwner(oneRule("{ action: email.send }", "deny"));
    expect(files.holder.reload().ok).toBe(true);
    expect(await h.call(SEND)).toMatchObject({ status: "denied" });
    expect(h.provider.executed).toHaveLength(2);
  });

  it("starts deciding once a broken boot file is fixed", async () => {
    const files = rulesHome();
    files.writeOwner("rules: [");
    files.holder.reload();
    const h = pipelineHarness({ rulesSource: files.holder });
    expect(await h.call(SEND)).toMatchObject({ status: "denied", reason: "rules_unavailable" });

    files.writeOwner(ALLOW_SENDS);
    expect(files.holder.reload().ok).toBe(true);

    expect((await h.call(SEND)).status).toBe("allowed");
    expect(h.provider.executed).toHaveLength(1);
  });
});
