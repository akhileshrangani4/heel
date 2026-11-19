import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { hashAgentToken, issueAgentToken } from "../gateway/agent-tokens.ts";
import { isValidAgentName } from "../gateway/agents.ts";
import type { HeelDb, HeelTx } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { agents, agentTokens, oauthClients, oauthCodes } from "../store/schema.ts";
import {
  ACCESS_TOKEN_TTL_MS,
  agentNameFor,
  CODE_TTL_MS,
  REFRESH_TOKEN_TTL_MS,
  redirectUriProblem,
  verifierMatches,
} from "./rules.ts";

/**
 * OAuth clients, codes and token pairs (A2). Access and refresh tokens are
 * ordinary heel agent tokens with a kind and an expiry, so revoking an agent
 * (`heel agent revoke`) cuts off its OAuth tokens too.
 */

export type ClientRow = typeof oauthClients.$inferSelect;

export class OAuthError extends Error {
  override readonly name = "OAuthError";
  /** The RFC 6749 / 7591 error code returned to the client. */
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** Dynamic client registration (RFC 7591), for public clients only. */
export function registerClient(
  db: HeelDb,
  input: { orgId: string; name: string; redirectUris: readonly string[]; now: Date },
): ClientRow {
  if (input.redirectUris.length === 0 || input.redirectUris.length > 5) {
    throw new OAuthError("invalid_redirect_uri", "register 1 to 5 redirect URIs");
  }
  for (const uri of input.redirectUris) {
    const problem = redirectUriProblem(uri);
    if (problem !== null) throw new OAuthError("invalid_redirect_uri", `${uri}: ${problem}`);
  }
  const row: ClientRow = {
    id: newId("oauthClient"),
    orgId: input.orgId,
    name: input.name.trim().slice(0, 80) || "MCP client",
    redirectUris: [...input.redirectUris],
    createdAt: input.now,
  };
  db.insert(oauthClients).values(row).run();
  return row;
}

export function findClient(db: HeelDb, orgId: string, clientId: string): ClientRow | null {
  return (
    db
      .select()
      .from(oauthClients)
      .where(and(eq(oauthClients.orgId, orgId), eq(oauthClients.id, clientId)))
      .get() ?? null
  );
}

/**
 * The agent a person's connection from this client acts as. Connecting the
 * same client again reuses its agent, so its history, counts and grants
 * carry over; otherwise a new agent is named after the client ("claude",
 * then "claude-2", …).
 */
/**
 * The agent a connection will act as, without creating it: this client's
 * live agent for the person if there is one (`existing`), else the first
 * free name from what the client calls itself. The consent page shows this,
 * so what the person approves is the agent they get.
 */
export function plannedAgentForClient(
  tx: HeelTx | HeelDb,
  input: { orgId: string; ownerId: string; client: ClientRow },
): { name: string; existing: boolean } | null {
  const existing = tx
    .select({ name: agents.name })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, input.orgId),
        eq(agents.ownerId, input.ownerId),
        eq(agents.oauthClientId, input.client.id),
        isNull(agents.revokedAt),
      ),
    )
    .get();
  if (existing !== undefined) return { name: existing.name, existing: true };
  const base = agentNameFor(input.client.name);
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!isValidAgentName(name)) continue;
    const taken = tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, input.orgId), eq(agents.name, name)))
      .get();
    if (taken === undefined) return { name, existing: false };
  }
  return null;
}

export function agentForClient(
  tx: HeelTx,
  input: { orgId: string; ownerId: string; client: ClientRow; now: Date },
): { agentId: string; name: string } {
  const existing = tx
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(
      and(
        eq(agents.orgId, input.orgId),
        eq(agents.ownerId, input.ownerId),
        eq(agents.oauthClientId, input.client.id),
        isNull(agents.revokedAt),
      ),
    )
    .get();
  if (existing !== undefined) return { agentId: existing.id, name: existing.name };
  const base = agentNameFor(input.client.name);
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!isValidAgentName(name)) continue;
    const taken = tx
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.orgId, input.orgId), eq(agents.name, name)))
      .get();
    if (taken !== undefined) continue;
    const agentId = newId("agent");
    tx.insert(agents)
      .values({
        id: agentId,
        orgId: input.orgId,
        ownerId: input.ownerId,
        name,
        oauthClientId: input.client.id,
        createdAt: input.now,
      })
      .run();
    return { agentId, name };
  }
  throw new OAuthError("server_error", "no free agent name for this client");
}

function hashCode(code: string): string {
  return createHash("sha256").update(code, "utf8").digest("hex");
}

/** Issues a one-time code for an agent, bound to the redirect URI and PKCE challenge. */
export function issueCode(
  tx: HeelTx,
  input: {
    orgId: string;
    clientId: string;
    agentId: string;
    redirectUri: string;
    codeChallenge: string;
    now: Date;
  },
): string {
  const code = randomBytes(32).toString("base64url");
  tx.insert(oauthCodes)
    .values({
      codeHash: hashCode(code),
      orgId: input.orgId,
      clientId: input.clientId,
      agentId: input.agentId,
      redirectUri: input.redirectUri,
      codeChallenge: input.codeChallenge,
      createdAt: input.now,
      expiresAt: new Date(input.now.getTime() + CODE_TTL_MS),
    })
    .run();
  return code;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

function issuePair(tx: HeelTx, agent: { orgId: string; agentId: string }, now: Date): TokenPair {
  return {
    accessToken: issueAgentToken(tx, agent, now, {
      kind: "oauth_access",
      expiresAt: new Date(now.getTime() + ACCESS_TOKEN_TTL_MS),
    }),
    refreshToken: issueAgentToken(tx, agent, now, {
      kind: "oauth_refresh",
      expiresAt: new Date(now.getTime() + REFRESH_TOKEN_TTL_MS),
    }),
    expiresInSeconds: ACCESS_TOKEN_TTL_MS / 1_000,
  };
}

/**
 * Trades a code for a token pair. The code works once, within a minute, for
 * the client and redirect URI it was issued to, and only with the verifier
 * its challenge came from.
 */
export function redeemCode(
  db: HeelDb,
  input: {
    orgId: string;
    clientId: string;
    code: string;
    redirectUri: string;
    verifier: string;
    now: Date;
  },
): TokenPair {
  return db.transaction(
    (tx) => {
      const row = tx
        .select()
        .from(oauthCodes)
        .where(
          and(eq(oauthCodes.orgId, input.orgId), eq(oauthCodes.codeHash, hashCode(input.code))),
        )
        .get();
      const invalid = new OAuthError(
        "invalid_grant",
        "the code is unknown, used, expired or not yours",
      );
      if (row === undefined || row.usedAt !== null) throw invalid;
      if (row.expiresAt.getTime() <= input.now.getTime()) throw invalid;
      if (row.clientId !== input.clientId || row.redirectUri !== input.redirectUri) throw invalid;
      if (!verifierMatches(input.verifier, row.codeChallenge)) throw invalid;
      tx.update(oauthCodes)
        .set({ usedAt: input.now })
        .where(eq(oauthCodes.codeHash, row.codeHash))
        .run();
      return issuePair(tx, { orgId: row.orgId, agentId: row.agentId }, input.now);
    },
    { behavior: "immediate" },
  );
}

/**
 * Trades a refresh token for a new pair. The old refresh token is revoked in
 * the same transaction (rotation), so a stolen one works at most once.
 */
export function refreshTokens(
  db: HeelDb,
  input: { orgId: string; refreshToken: string; now: Date },
): TokenPair {
  return db.transaction(
    (tx) => {
      const row = tx
        .select({
          id: agentTokens.id,
          agentId: agentTokens.agentId,
          kind: agentTokens.kind,
          expiresAt: agentTokens.expiresAt,
          revokedAt: agentTokens.revokedAt,
          agentRevokedAt: agents.revokedAt,
        })
        .from(agentTokens)
        .innerJoin(agents, eq(agents.id, agentTokens.agentId))
        .where(
          and(
            eq(agentTokens.orgId, input.orgId),
            eq(agentTokens.tokenHash, hashAgentToken(input.refreshToken)),
          ),
        )
        .get();
      const live =
        row !== undefined &&
        row.kind === "oauth_refresh" &&
        row.revokedAt === null &&
        row.agentRevokedAt === null &&
        row.expiresAt !== null &&
        row.expiresAt.getTime() > input.now.getTime();
      if (!live)
        throw new OAuthError(
          "invalid_grant",
          "the refresh token is unknown, used, revoked or expired",
        );
      tx.update(agentTokens).set({ revokedAt: input.now }).where(eq(agentTokens.id, row.id)).run();
      return issuePair(tx, { orgId: input.orgId, agentId: row.agentId }, input.now);
    },
    { behavior: "immediate" },
  );
}
