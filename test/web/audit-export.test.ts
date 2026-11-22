import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../../src/core/audit.ts";
import { appendAudit } from "../../src/store/audit.ts";
import { humanPlaneHarness } from "../helpers/human-plane.ts";

/**
 * Roadmap 2.9, part 4: the audit log from the web app, as `heel audit export`
 * writes it. Admins only, since it's everyone's.
 */

function deny(orgId: string, n: number): AuditEvent {
  return {
    kind: "deny",
    call: {
      orgId,
      agentId: "agt_inboxbot",
      ownerId: "usr_someone",
      runId: "run-1",
      surface: "mcp",
      account: "gmail-work",
      provider: "gmail",
      tool: "trash",
      args: { id: `msg-${n}` },
      action: "email.remove",
      kind: "write",
      items: 1,
    },
    callHash: n.toString(16).padStart(64, "0"),
    rule: null,
    reason: "no rule matched",
  };
}

describe("audit export in the web app (2.9)", () => {
  it("gives an admin the log as JSON Lines, a download no browser keeps", async () => {
    const h = humanPlaneHarness();
    const owner = await h.signIn(await h.enroll());
    appendAudit(h.t.db, deny(h.t.orgId, 1), new Date("2026-11-10T12:00:00Z"));
    appendAudit(h.t.db, deny(h.t.orgId, 2), new Date("2026-11-12T23:59:00Z"));
    appendAudit(h.t.db, deny(h.t.orgId, 3), new Date("2026-11-13T00:00:00Z"));

    const page = await (await h.fetch("/activity", { as: owner })).text();
    expect(page).toContain("Download the audit log");

    const all = await h.fetch("/activity/export", { as: owner });
    expect(all.status).toBe(200);
    expect(all.headers.get("cache-control")).toBe("no-store");
    expect(all.headers.get("content-disposition")).toMatch(/^attachment; filename="heel-audit-/);
    const lines = (await all.text())
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { kind: string });
    expect(lines.filter((l) => l.kind === "deny")).toHaveLength(3);

    // Both days included.
    const window = await (
      await h.fetch("/activity/export?since=2026-11-11&until=2026-11-12", { as: owner })
    ).text();
    expect(window.trim().split("\n")).toHaveLength(1);
    expect(window).toContain("msg-2");
  });

  it("a member can't export everyone's log", async () => {
    const h = humanPlaneHarness();
    await h.signIn(await h.enroll());
    h.addUser("sam", "member");
    const sam = await h.signIn(await h.enroll("sam"));
    expect((await h.fetch("/activity/export", { as: sam })).status).toBe(403);
    expect(await (await h.fetch("/activity", { as: sam })).text()).not.toContain(
      "Download the audit log",
    );
  });
});
