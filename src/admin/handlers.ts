import { and, eq } from "drizzle-orm";
import { exportAuditPage } from "../audit/export.ts";
import {
  AgentError,
  type AgentErrorCode,
  addAgent,
  listAgents,
  revokeAgent,
  rotateAgentToken,
} from "../gateway/agents.ts";
import type { HeelDb } from "../store/db.ts";
import { LOCAL_OWNER_NAME } from "../store/install.ts";
import { users } from "../store/schema.ts";
import {
  ConnectError,
  type ConnectErrorCode,
  connectAccount,
  listAccounts,
} from "../vault/connect.ts";
import type { Vault } from "../vault/vault.ts";
import {
  type AdminErrorCode,
  type AdminRequest,
  type AdminResponse,
  adminError,
  adminOk,
} from "./protocol.ts";
import type { AdminHandler } from "./server.ts";

export interface AdminDeps {
  db: HeelDb;
  orgId: string;
  /** Null when no master key is configured; credential writes are refused. */
  vault: Vault | null;
  version: string;
  now?: () => Date;
}

const AGENT_ERROR_CODES: Record<AgentErrorCode, AdminErrorCode> = {
  invalid_name: "invalid",
  name_taken: "conflict",
  not_found: "not_found",
  revoked: "conflict",
};

const CONNECT_ERROR_CODES: Record<ConnectErrorCode, AdminErrorCode> = {
  invalid_alias: "invalid",
  unknown_provider: "invalid",
  alias_taken: "conflict",
  vault_unavailable: "vault_unavailable",
};

class OwnerNotFound extends Error {
  override readonly name = "OwnerNotFound";
}

function resolveOwner(db: HeelDb, orgId: string, name: string | undefined): string {
  const ownerName = name ?? LOCAL_OWNER_NAME;
  const row = db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.orgId, orgId), eq(users.name, ownerName)))
    .get();
  if (!row) throw new OwnerNotFound(`no user named "${ownerName}"`);
  return row.id;
}

function dispatch(deps: AdminDeps, request: AdminRequest, now: Date): AdminResponse {
  const { db, orgId } = deps;
  switch (request.method) {
    case "ping":
      return adminOk({ version: deps.version, vault: deps.vault ? "open" : "unavailable" });
    case "agent.add": {
      const ownerId = resolveOwner(db, orgId, request.params.owner);
      return adminOk(addAgent(db, { orgId, ownerId, name: request.params.name }, now));
    }
    case "agent.rotate":
      return adminOk(rotateAgentToken(db, orgId, request.params.name, now));
    case "agent.revoke":
      revokeAgent(db, orgId, request.params.name, now);
      return adminOk({ name: request.params.name, revoked: true });
    case "agent.list":
      return adminOk(
        listAgents(db, orgId).map((agent) => ({
          ...agent,
          createdAt: agent.createdAt.toISOString(),
          revokedAt: agent.revokedAt?.toISOString() ?? null,
        })),
      );
    case "account.connect": {
      const { provider, alias, owner, credential } = request.params;
      const ownerId = resolveOwner(db, orgId, owner);
      const input = { orgId, ownerId, provider, alias, ...(credential ? { credential } : {}) };
      return adminOk(connectAccount(db, deps.vault, input, now));
    }
    case "account.list":
      return adminOk(listAccounts(db, orgId));
    case "audit.export": {
      const { since, until, afterId, throughId, limit } = request.params;
      return adminOk(
        exportAuditPage(db, orgId, {
          afterId,
          limit,
          ...(since === undefined ? {} : { since: new Date(since) }),
          ...(until === undefined ? {} : { until: new Date(until) }),
          ...(throughId === undefined ? {} : { throughId }),
        }),
      );
    }
  }
}

/**
 * Admin methods over the store. Expected failures (a taken name, an unknown
 * agent) become typed error responses; anything else propagates so the
 * server logs it and answers `internal`.
 */
export function createAdminHandler(deps: AdminDeps): AdminHandler {
  const now = deps.now ?? (() => new Date());
  return (request) => {
    try {
      return dispatch(deps, request, now());
    } catch (error) {
      if (error instanceof AgentError) {
        return adminError(AGENT_ERROR_CODES[error.code], error.message);
      }
      if (error instanceof ConnectError) {
        return adminError(CONNECT_ERROR_CODES[error.code], error.message);
      }
      if (error instanceof OwnerNotFound) return adminError("not_found", error.message);
      throw error;
    }
  };
}
