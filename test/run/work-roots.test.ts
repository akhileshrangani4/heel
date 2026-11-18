import { mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { addAgent, setWorkRoots, workRootsOf } from "../../src/gateway/agents.ts";
import { testStore } from "../helpers/store.ts";

/** `heel agent workdir` (D8b): where an agent's `heel run` may start. */

describe("agent work roots", () => {
  function setUp() {
    const t = testStore();
    const { agentId } = addAgent(
      t.db,
      { orgId: t.orgId, ownerId: t.ownerId, name: "coder" },
      new Date(),
    );
    return { t, agentId };
  }

  const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "heel-root-")));

  it("stores existing directories, resolved, and reads them back", () => {
    const { t, agentId } = setUp();
    expect(workRootsOf(t.db, agentId)).toEqual([]);
    const a = dir();
    const b = dir();
    const link = join(dir(), "link");
    symlinkSync(b, link);
    setWorkRoots(t.db, t.orgId, "coder", [a, `${link}/`]);
    expect(workRootsOf(t.db, agentId)).toEqual([a, b]);
    setWorkRoots(t.db, t.orgId, "coder", []);
    expect(workRootsOf(t.db, agentId)).toEqual([]);
  });

  it.each([
    "/",
    "/etc",
    "/usr/local",
    "/tmp",
    "relative/dir",
    "/srv/../etc",
    "/no/such/dir",
    "/private/etc",
  ])("refuses %s", (root) => {
    const { t } = setUp();
    expect(() => setWorkRoots(t.db, t.orgId, "coder", [root])).toThrow(/work root/);
  });

  it("refuses a root that overlaps heel's home", () => {
    const { t } = setUp();
    const home = dir();
    expect(() => setWorkRoots(t.db, t.orgId, "coder", [home], [home])).toThrow(/heel's own/);
    expect(() => setWorkRoots(t.db, t.orgId, "coder", [join(home, "..")], [home])).toThrow(
      /heel's own|system/,
    );
  });
});
