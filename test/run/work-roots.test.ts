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

  it("stores absolute directories and reads them back", () => {
    const { t, agentId } = setUp();
    expect(workRootsOf(t.db, agentId)).toEqual([]);
    setWorkRoots(t.db, t.orgId, "coder", ["/srv/work/coder", "/srv/scratch/"]);
    expect(workRootsOf(t.db, agentId)).toEqual(["/srv/work/coder", "/srv/scratch"]);
    setWorkRoots(t.db, t.orgId, "coder", []);
    expect(workRootsOf(t.db, agentId)).toEqual([]);
  });

  it.each(["/", "/etc", "/home", "/tmp", "relative/dir", "/srv/../etc"])("refuses %s", (root) => {
    const { t } = setUp();
    expect(() => setWorkRoots(t.db, t.orgId, "coder", [root])).toThrow(/work root/);
  });
});
