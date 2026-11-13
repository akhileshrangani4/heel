import { readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  authenticateAgent,
  generateAgentToken,
  hashAgentToken,
  isAgentTokenShape,
  parseBearer,
} from "../../src/gateway/agent-tokens.ts";
import {
  AgentError,
  addAgent,
  listAgents,
  revokeAgent,
  rotateAgentToken,
} from "../../src/gateway/agents.ts";
import { type AgentPlaneEnv, requireAgent } from "../../src/gateway/require-agent.ts";
import { createLogger } from "../../src/log.ts";
import { agentTokens, users } from "../../src/store/schema.ts";
import { type TestStore, testStore } from "../helpers/store.ts";

const NOW = new Date("2026-11-13T12:00:00Z");
const silent = createLogger("silent");

function agentWithToken(t: TestStore, name = "inbox-bot") {
  return addAgent(t.db, { orgId: t.orgId, ownerId: t.ownerId, name }, NOW);
}

/** A minimal agent plane: auth, then a handler that stands in for the pipeline. */
function plane(t: TestStore) {
  const pipeline = vi.fn((agentId: string) => agentId);
  const app = new Hono<AgentPlaneEnv>();
  app.use("*", requireAgent({ db: t.db, log: silent }));
  app.all("*", (c) => c.json({ agentId: pipeline(c.get("agent").agentId) }));
  const call = (headers: Record<string, string> = {}, path = "/mcp") =>
    app.request(`http://127.0.0.1:7300${path}`, { method: "POST", headers });
  return { pipeline, call };
}

describe("token format", () => {
  it("generates prefixed 256-bit tokens", () => {
    const token = generateAgentToken();
    expect(isAgentTokenShape(token)).toBe(true);
    expect(token).not.toBe(generateAgentToken());
  });

  it("parses only `Bearer <heel token>`", () => {
    const token = generateAgentToken();
    expect(parseBearer(undefined)).toEqual({ kind: "missing" });
    expect(parseBearer("  ")).toEqual({ kind: "missing" });
    expect(parseBearer(`Bearer ${token}`)).toEqual({ kind: "token", token });
    expect(parseBearer(`bearer ${token}`)).toEqual({ kind: "token", token });
    expect(parseBearer(token)).toEqual({ kind: "malformed" });
    expect(parseBearer(`Basic ${token}`)).toEqual({ kind: "malformed" });
    expect(parseBearer(`Bearer ${token} extra`)).toEqual({ kind: "malformed" });
    expect(parseBearer("Bearer ghp_providerTokenNotHeel")).toEqual({ kind: "malformed" });
  });
});

describe("agent tokens", () => {
  it("I-03: stores only the token's SHA-256", () => {
    const t = testStore();
    const { agentId, token } = agentWithToken(t);
    const rows = t.db.select().from(agentTokens).where(eq(agentTokens.agentId, agentId)).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tokenHash).toBe(hashAgentToken(token));
    expect(readFileSync(t.path).includes(Buffer.from(token))).toBe(false);
    const wal = readFileSync(`${t.path}-wal`);
    expect(wal.includes(Buffer.from(token))).toBe(false);
  });

  it("authenticates a live token to its agent, owner and org", () => {
    const t = testStore();
    const { agentId, token } = agentWithToken(t);
    const result = authenticateAgent(t.db, `Bearer ${token}`);
    expect(result).toMatchObject({
      ok: true,
      agent: { agentId, agentName: "inbox-bot", ownerId: t.ownerId, orgId: t.orgId },
    });
  });

  it("I-03: rejects a missing token", () => {
    const t = testStore();
    expect(authenticateAgent(t.db, undefined)).toEqual({ ok: false, failure: "missing" });
  });

  it("I-03: rejects an unknown token", () => {
    const t = testStore();
    agentWithToken(t);
    expect(authenticateAgent(t.db, `Bearer ${generateAgentToken()}`)).toEqual({
      ok: false,
      failure: "unknown",
    });
  });

  it("I-03: rejects a rotated-out token on the next call", () => {
    const t = testStore();
    const { token: old } = agentWithToken(t);
    const { token: fresh } = rotateAgentToken(t.db, t.orgId, "inbox-bot", NOW);
    expect(authenticateAgent(t.db, `Bearer ${old}`)).toEqual({ ok: false, failure: "revoked" });
    expect(authenticateAgent(t.db, `Bearer ${fresh}`).ok).toBe(true);
  });

  it("I-03: rejects every token of a revoked agent", () => {
    const t = testStore();
    const { token } = agentWithToken(t);
    revokeAgent(t.db, t.orgId, "inbox-bot", NOW);
    expect(authenticateAgent(t.db, `Bearer ${token}`)).toEqual({ ok: false, failure: "revoked" });
    expect(() => rotateAgentToken(t.db, t.orgId, "inbox-bot", NOW)).toThrow(AgentError);
  });

  it("I-03: rejects tokens of an agent whose owner is disabled", () => {
    const t = testStore();
    const { token } = agentWithToken(t);
    t.db.update(users).set({ disabledAt: NOW }).where(eq(users.id, t.ownerId)).run();
    expect(authenticateAgent(t.db, `Bearer ${token}`)).toEqual({ ok: false, failure: "revoked" });
  });
});

describe("agent lifecycle", () => {
  it("validates names and keeps them unique, even after revocation", () => {
    const t = testStore();
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        if (error instanceof AgentError) return error.code;
        throw error;
      }
      return "ok";
    };
    expect(code(() => agentWithToken(t, "-bad"))).toBe("invalid_name");
    expect(code(() => agentWithToken(t, "has space"))).toBe("invalid_name");
    expect(code(() => agentWithToken(t, "ci-bot"))).toBe("ok");
    expect(code(() => agentWithToken(t, "ci-bot"))).toBe("name_taken");
    revokeAgent(t.db, t.orgId, "ci-bot", NOW);
    expect(code(() => agentWithToken(t, "ci-bot"))).toBe("name_taken");
    expect(code(() => revokeAgent(t.db, t.orgId, "nobody", NOW))).toBe("not_found");
    expect(listAgents(t.db, t.orgId).map((a) => [a.name, a.revokedAt !== null])).toEqual([
      ["ci-bot", true],
    ]);
  });
});

describe("agent plane authentication", () => {
  it("I-03: a valid token reaches the pipeline", async () => {
    const t = testStore();
    const { agentId, token } = agentWithToken(t);
    const { pipeline, call } = plane(t);
    const response = await call({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ agentId });
    expect(pipeline).toHaveBeenCalledTimes(1);
  });

  it("I-03: missing, unknown, provider and revoked tokens are rejected before rules run", async () => {
    const t = testStore();
    const { token } = agentWithToken(t);
    const { token: revoked } = agentWithToken(t, "old-bot");
    revokeAgent(t.db, t.orgId, "old-bot", NOW);
    const { pipeline, call } = plane(t);

    const attempts: Record<string, string>[] = [
      {},
      { authorization: `Bearer ${generateAgentToken()}` },
      { authorization: "Bearer ghp_aProviderTokenAnAgentShouldNeverSend" },
      { authorization: `Bearer ${revoked}` },
      { authorization: token },
    ];
    for (const headers of attempts) {
      const response = await call(headers);
      expect(response.status).toBe(401);
      expect(response.headers.get("www-authenticate")).toBe('Bearer realm="heel"');
      expect(await response.text()).toBe("");
    }
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("I-03: a token in the query string is rejected, even alongside a valid header", async () => {
    const t = testStore();
    const { token } = agentWithToken(t);
    const { pipeline, call } = plane(t);
    const response = await call(
      { authorization: `Bearer ${token}` },
      `/mcp?access_token=${encodeURIComponent(token)}`,
    );
    expect(response.status).toBe(401);
    expect(pipeline).not.toHaveBeenCalled();
  });

  it("fails closed with 503 when the store cannot be read", async () => {
    const t = testStore();
    const { token } = agentWithToken(t);
    const { pipeline, call } = plane(t);
    t.store.close();
    const response = await call({ authorization: `Bearer ${token}` });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "denied", reason: "heel error" });
    expect(pipeline).not.toHaveBeenCalled();
  });
});
