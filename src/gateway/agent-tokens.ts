import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { HeelDb, HeelTx } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { agents, agentTokens, users } from "../store/schema.ts";

/**
 * Per-agent bearer tokens (spec: MCP and code mode, "Agent authentication").
 * A token is shown once when issued; heel keeps only its SHA-256 (I-03).
 * The `heel_` prefix lets secret scanners recognise a leaked token.
 */

const TOKEN_PREFIX = "heel_";
const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^heel_[A-Za-z0-9_-]{43}$/;

/** Pure: true when `text` has the shape of a heel agent token. */
export function isAgentTokenShape(text: string): boolean {
  return TOKEN_PATTERN.test(text);
}

export function generateAgentToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(TOKEN_BYTES).toString("base64url")}`;
}

/** Pure: the stored form of a token, lower-case hex SHA-256. */
export function hashAgentToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export type BearerParse =
  | { kind: "token"; token: string }
  | { kind: "missing" }
  | { kind: "malformed" };

/**
 * Pure: reads an `Authorization` header value. Only `Bearer <heel token>` is
 * accepted; anything else, including a provider token, is malformed, so it
 * can never be mistaken for a credential to pass upstream (MCP §0 fact 2).
 */
export function parseBearer(header: string | undefined): BearerParse {
  if (header === undefined || header.trim() === "") return { kind: "missing" };
  const match = /^Bearer[ ]+(\S+)[ ]*$/i.exec(header);
  const token = match?.[1];
  if (token === undefined || !isAgentTokenShape(token)) return { kind: "malformed" };
  return { kind: "token", token };
}

export type AgentAuthFailure = "missing" | "malformed" | "unknown" | "revoked";

export interface AuthenticatedAgent {
  orgId: string;
  agentId: string;
  agentName: string;
  ownerId: string;
  tokenId: string;
}

export type AgentAuthResult =
  | { ok: true; agent: AuthenticatedAgent }
  | { ok: false; failure: AgentAuthFailure };

/**
 * Resolves an `Authorization` header to an agent. Runs first on every agent
 * plane request: a missing, unknown or revoked token stops here, before any
 * rule, lookup or upstream is touched (I-03). A token is revoked when it, its
 * agent, or the agent's owner has been revoked or disabled.
 */
export function authenticateAgent(db: HeelDb, header: string | undefined): AgentAuthResult {
  const parsed = parseBearer(header);
  if (parsed.kind !== "token") return { ok: false, failure: parsed.kind };
  const row = db
    .select({
      tokenId: agentTokens.id,
      tokenRevokedAt: agentTokens.revokedAt,
      orgId: agents.orgId,
      agentId: agents.id,
      agentName: agents.name,
      agentRevokedAt: agents.revokedAt,
      ownerId: agents.ownerId,
      ownerDisabledAt: users.disabledAt,
    })
    .from(agentTokens)
    .innerJoin(agents, eq(agents.id, agentTokens.agentId))
    .innerJoin(users, eq(users.id, agents.ownerId))
    .where(eq(agentTokens.tokenHash, hashAgentToken(parsed.token)))
    .get();
  if (!row) return { ok: false, failure: "unknown" };
  if (row.tokenRevokedAt || row.agentRevokedAt || row.ownerDisabledAt) {
    return { ok: false, failure: "revoked" };
  }
  return {
    ok: true,
    agent: {
      orgId: row.orgId,
      agentId: row.agentId,
      agentName: row.agentName,
      ownerId: row.ownerId,
      tokenId: row.tokenId,
    },
  };
}

/** Issues a new token for an agent inside `tx`; returns the plaintext once. */
export function issueAgentToken(
  tx: HeelTx,
  agent: { orgId: string; agentId: string },
  now: Date,
): string {
  const token = generateAgentToken();
  tx.insert(agentTokens)
    .values({
      id: newId("agentToken"),
      orgId: agent.orgId,
      agentId: agent.agentId,
      tokenHash: hashAgentToken(token),
      createdAt: now,
      revokedAt: null,
    })
    .run();
  return token;
}

/** Revokes every live token of an agent inside `tx`. */
export function revokeAgentTokens(tx: HeelTx, agentId: string, now: Date): void {
  tx.update(agentTokens)
    .set({ revokedAt: now })
    .where(and(eq(agentTokens.agentId, agentId), isNull(agentTokens.revokedAt)))
    .run();
}
