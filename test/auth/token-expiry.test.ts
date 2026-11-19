import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { authenticateAgent } from "../../src/gateway/agent-tokens.ts";
import {
  addAgent,
  DEFAULT_TOKEN_DAYS,
  expiringTokens,
  listAgents,
  rotateAgentToken,
  tokenExpiry,
} from "../../src/gateway/agents.ts";
import { withExpiryNote } from "../../src/gateway/mcp/server.ts";
import { refusalBody } from "../../src/gateway/require-agent.ts";
import { agentTokens } from "../../src/store/schema.ts";
import { testStore } from "../helpers/store.ts";

/** Roadmap 1.6: agent tokens expire, by default after 90 days, with warnings first. */

const DAY = 86_400_000;
const NOW = new Date("2026-11-19T12:00:00Z");

describe("agent token expiry", () => {
  it("issues tokens that expire in 90 days by default, or when asked, or never", () => {
    expect(tokenExpiry(NOW, undefined)?.getTime()).toBe(NOW.getTime() + DEFAULT_TOKEN_DAYS * DAY);
    expect(tokenExpiry(NOW, 30)?.getTime()).toBe(NOW.getTime() + 30 * DAY);
    expect(tokenExpiry(NOW, null)).toBeNull();

    const t = testStore();
    const added = addAgent(t.db, { orgId: t.orgId, ownerId: t.ownerId, name: "bot" }, NOW);
    expect(added.expiresAt).toBe(new Date(NOW.getTime() + 90 * DAY).toISOString());
    const never = rotateAgentToken(t.db, t.orgId, "bot", NOW, null);
    expect(never.expiresAt).toBeNull();
    expect(listAgents(t.db, t.orgId)).toMatchObject([
      { name: "bot", hasToken: true, tokenExpiresAt: null },
    ]);
  });

  it("refuses an expired token with a reason that says how to fix it", () => {
    const t = testStore();
    const { token } = addAgent(
      t.db,
      { orgId: t.orgId, ownerId: t.ownerId, name: "bot", expiresInDays: 1 },
      NOW,
    );
    expect(authenticateAgent(t.db, `Bearer ${token}`, new Date(NOW.getTime() + DAY / 2)).ok).toBe(
      true,
    );
    expect(authenticateAgent(t.db, `Bearer ${token}`, new Date(NOW.getTime() + 2 * DAY))).toEqual({
      ok: false,
      failure: "expired",
    });
    expect(refusalBody("expired")).toMatchObject({ reason: "token_expired" });
    expect(refusalBody("expired").message).toContain("heel agent rotate");
  });

  it("warns from 14 days out, soonest first, and not about tokens that never expire", () => {
    const t = testStore();
    for (const [name, days] of [
      ["soon", 3],
      ["later", 60],
      ["sooner", 1],
      ["forever", null],
    ] as const) {
      addAgent(t.db, { orgId: t.orgId, ownerId: t.ownerId, name, expiresInDays: days }, NOW);
    }
    expect(expiringTokens(listAgents(t.db, t.orgId), NOW).map((e) => e.name)).toEqual([
      "sooner",
      "soon",
    ]);
  });

  it("adds a line to the agent's tool results in the last 14 days", () => {
    const result = { content: [{ type: "text" as const, text: "ok" }] };
    const agent = (days: number | null) => ({
      agentName: "bot",
      tokenExpiresAt: days === null ? null : new Date(NOW.getTime() + days * DAY),
    });
    expect(withExpiryNote(result, agent(30), NOW)).toBe(result);
    expect(withExpiryNote(result, agent(null), NOW)).toBe(result);
    const noted = withExpiryNote(result, agent(3), NOW);
    expect(noted.content).toHaveLength(2);
    expect(noted.content?.[1]).toMatchObject({
      type: "text",
      text: expect.stringContaining("heel agent rotate bot"),
    });
  });

  it("migration 0022 gives tokens issued before it 90 days from the upgrade, once", () => {
    const t = testStore();
    const { token: old } = addAgent(
      t.db,
      { orgId: t.orgId, ownerId: t.ownerId, name: "old", expiresInDays: null },
      NOW,
    );
    expect(authenticateAgent(t.db, `Bearer ${old}`, NOW).ok).toBe(true);
    const sql = readFileSync(
      join(import.meta.dirname, "../../src/store/migrations/0022_agent_token_expiry.sql"),
      "utf8",
    );
    const before = Date.now();
    t.store.sqlite.exec(sql);
    const [row] = t.db.select({ expiresAt: agentTokens.expiresAt }).from(agentTokens).all();
    const expires = row?.expiresAt?.getTime() ?? 0;
    expect(expires).toBeGreaterThanOrEqual(before + 90 * DAY - 1000);
    expect(expires).toBeLessThanOrEqual(Date.now() + 90 * DAY + 1000);
    // Revoked tokens aren't touched.
    t.db
      .update(agentTokens)
      .set({ expiresAt: null, revokedAt: NOW })
      .where(eq(agentTokens.kind, "static"))
      .run();
    t.store.sqlite.exec(sql);
    expect(t.db.select({ e: agentTokens.expiresAt }).from(agentTokens).all()).toEqual([
      { e: null },
    ]);
  });
});
