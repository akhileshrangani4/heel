import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chooseHome, initHome, initSummary, STARTER_RULES } from "../../src/cli/init.ts";
import { compileRulesText } from "../../src/config/rules.ts";
import { tempDir } from "../helpers/store.ts";

/** `heel init` (1.12): first-run setup that never overwrites anything. */
describe("heel init", () => {
  it("creates a private home, a master key, heel.yaml and starter rules", () => {
    const home = join(tempDir("heel-init-"), "home");
    const steps = initHome(home);
    expect(steps.map((s) => s.done)).toEqual(["created", "created", "created", "created"]);
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, "master.key")).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, "heel.yaml"), "utf8")).toContain("agent: 127.0.0.1:7300");
    expect(readFileSync(join(home, "rules", "owner.yaml"), "utf8")).toBe(STARTER_RULES);
  });

  it("keeps everything that's already there, byte for byte", () => {
    const home = tempDir("heel-init-");
    mkdirSync(join(home, "rules"));
    writeFileSync(join(home, "master.key"), "existing-key\n");
    writeFileSync(join(home, "heel.yaml"), "log: { level: debug }\n");
    writeFileSync(join(home, "rules", "alice.yaml"), "rules: []\n");
    expect(initHome(home).map((s) => s.done)).toEqual(["kept", "kept", "kept", "kept"]);
    expect(readFileSync(join(home, "master.key"), "utf8")).toBe("existing-key\n");
    expect(readFileSync(join(home, "heel.yaml"), "utf8")).toBe("log: { level: debug }\n");
  });

  it("writes starter rules that load: reads run, everything else asks", () => {
    const compiled = compileRulesText(
      STARTER_RULES,
      "rules/owner.yaml",
      "rules/owner.yaml",
      "owner",
    );
    expect(compiled.file.rules.map((r) => r.decision)).toEqual(["allow", "ask"]);
    expect(compiled.warnings).toEqual([]);
  });

  it("says to export HEEL_HOME only when it didn't come from there, and to back up a new key", () => {
    const home = "/home/me/.heel";
    const created = [{ what: `${home}/master.key`, done: "created" as const }];
    expect(initSummary(home, created, false)).toContain(`export HEEL_HOME=${home}`);
    expect(initSummary(home, created, true)).not.toContain("export HEEL_HOME");
    expect(initSummary(home, created, true)).toContain("Back up master.key");
    expect(initSummary(home, [{ what: `${home}/master.key`, done: "kept" }], true)).not.toContain(
      "Back up",
    );
  });

  it("on a server, says how an agent on any computer signs in, with no token to copy (2.8)", () => {
    const summary = initSummary("/srv/heel", [], true, {
      approvals: "https://box.tail.ts.net",
      agents: "https://box.tail.ts.net:8443",
    });
    expect(summary).toContain(
      "claude mcp add --transport http --scope user heel https://box.tail.ts.net:8443/mcp",
    );
    expect(summary).toContain("codex mcp login heel");
    expect(summary).not.toContain("copy its token");
    expect(initSummary("/srv/heel", [], true)).toContain("copy its token");
  });

  it("puts heel in --home, then HEEL_HOME, then ~/.heel", () => {
    expect(chooseHome("/srv/heel", { HEEL_HOME: "/x" })).toBe("/srv/heel");
    expect(chooseHome(undefined, { HEEL_HOME: "/x" })).toBe("/x");
    expect(chooseHome(undefined, {})).toMatch(/\/\.heel$/);
  });
});
