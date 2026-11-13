import { and, eq } from "drizzle-orm";
import type { HeelDb, HeelTx } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { agents } from "../store/schema.ts";
import { issueAgentToken, revokeAgentTokens } from "./agent-tokens.ts";

/**
 * Agent lifecycle behind `heel agent add|rotate|revoke|list` (spec: MCP and
 * code mode, "Agent authentication"). Every change takes effect on the next
 * call, because authentication reads the store on every request.
 */

/** Agent names appear in rules (`agent: inbox-bot`) and audit rows. */
const AGENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidAgentName(name: string): boolean {
  return AGENT_NAME.test(name);
}

export type AgentErrorCode = "invalid_name" | "name_taken" | "not_found" | "revoked";

export class AgentError extends Error {
  override readonly name = "AgentError";
  readonly code: AgentErrorCode;
  constructor(code: AgentErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export interface AgentSummary {
  id: string;
  name: string;
  ownerId: string;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface IssuedAgent {
  agentId: string;
  name: string;
  /** Shown once; heel stores only its hash. */
  token: string;
}

function findAgent(tx: HeelTx, orgId: string, name: string) {
  return tx
    .select()
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.name, name)))
    .get();
}

function requireLiveAgent(tx: HeelTx, orgId: string, name: string) {
  const agent = findAgent(tx, orgId, name);
  if (!agent) throw new AgentError("not_found", `no agent named "${name}"`);
  if (agent.revokedAt) throw new AgentError("revoked", `agent "${name}" is revoked`);
  return agent;
}

export function addAgent(
  db: HeelDb,
  input: { orgId: string; ownerId: string; name: string },
  now: Date,
): IssuedAgent {
  if (!isValidAgentName(input.name)) {
    throw new AgentError(
      "invalid_name",
      "agent names are 1–64 characters of letters, digits, '.', '_' or '-', starting with a letter or digit",
    );
  }
  return db.transaction((tx) => {
    // Names stay reserved after revocation so audit history keeps one meaning.
    if (findAgent(tx, input.orgId, input.name)) {
      throw new AgentError("name_taken", `an agent named "${input.name}" already exists`);
    }
    const agentId = newId("agent");
    tx.insert(agents)
      .values({
        id: agentId,
        orgId: input.orgId,
        ownerId: input.ownerId,
        name: input.name,
        createdAt: now,
        revokedAt: null,
      })
      .run();
    const token = issueAgentToken(tx, { orgId: input.orgId, agentId }, now);
    return { agentId, name: input.name, token };
  });
}

/** Replaces every token of a live agent with one new token. */
export function rotateAgentToken(db: HeelDb, orgId: string, name: string, now: Date): IssuedAgent {
  return db.transaction((tx) => {
    const agent = requireLiveAgent(tx, orgId, name);
    revokeAgentTokens(tx, agent.id, now);
    const token = issueAgentToken(tx, { orgId, agentId: agent.id }, now);
    return { agentId: agent.id, name: agent.name, token };
  });
}

/** Revokes an agent and all its tokens. Irreversible: add a new agent instead. */
export function revokeAgent(db: HeelDb, orgId: string, name: string, now: Date): void {
  db.transaction((tx) => {
    const agent = requireLiveAgent(tx, orgId, name);
    tx.update(agents).set({ revokedAt: now }).where(eq(agents.id, agent.id)).run();
    revokeAgentTokens(tx, agent.id, now);
  });
}

export function listAgents(db: HeelDb, orgId: string): AgentSummary[] {
  return db
    .select({
      id: agents.id,
      name: agents.name,
      ownerId: agents.ownerId,
      createdAt: agents.createdAt,
      revokedAt: agents.revokedAt,
    })
    .from(agents)
    .where(eq(agents.orgId, orgId))
    .orderBy(agents.name)
    .all();
}
