import { and, eq } from "drizzle-orm";
import { exportAuditPage } from "../audit/export.ts";
import {
  type ConfiguredSignIns,
  missingSignInSetup,
  signInSetupFor,
} from "../definitions/sign-in-setup.ts";
import {
  AgentError,
  type AgentErrorCode,
  addAgent,
  agentIdByName,
  listAgents,
  revokeAgent,
  rotateAgentToken,
  setWorkRoots,
} from "../gateway/agents.ts";
import { listStanding, revokeStanding } from "../store/approvals.ts";
import type { HeelDb } from "../store/db.ts";
import { LOCAL_OWNER_NAME } from "../store/install.ts";
import { setUserEmail } from "../store/notifications.ts";
import { ADMIN_SOCKET_ACTOR, listPauses, type PauseKey, pause } from "../store/pauses.ts";
import { accounts, users } from "../store/schema.ts";
import {
  SharingError,
  setApprovers,
  shareAccount,
  sharingOf,
  unshareAccount,
} from "../store/sharing.ts";
import {
  ConnectError,
  type ConnectErrorCode,
  configureAccount,
  connectAccount,
  listAccounts,
} from "../vault/connect.ts";
import type { Vault } from "../vault/vault.ts";
import { createEnrollment, EnrollmentError } from "../web/passkeys.ts";
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
  /** The human plane's public origin; enrollment links point at it. */
  publicUrl: URL;
  /** heel's own state directory; no agent work root may overlap it (D8b). */
  home?: string;
  /** `heel account set` changed how an account's server runs: stop the one running now. */
  onAccountConfigured?: (accountId: string) => void;
  /**
   * Which sign-in clients (`providers.google`, `providers.microsoft`) heel
   * started with, so `heel connect gmail` can say when its owner can't sign
   * in yet. Left out, connect says nothing about it.
   */
  signIns?: ConfiguredSignIns;
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
  invalid_settings: "invalid",
  alias_taken: "conflict",
  not_found: "not_found",
  vault_unavailable: "vault_unavailable",
};

class OwnerNotFound extends Error {
  override readonly name = "OwnerNotFound";
}

class TargetNotFound extends Error {
  override readonly name = "TargetNotFound";
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

type PauseParams = Extract<AdminRequest, { method: "pause" }>["params"];

/**
 * The pause row a `heel pause` names. Targets are checked to exist, so a
 * typo fails loudly instead of pausing nothing.
 */
function pauseKeyFor(db: HeelDb, orgId: string, params: PauseParams): PauseKey {
  switch (params.scope) {
    case "global":
      return { scope: "global", target: "" };
    case "agent":
      return { scope: "agent", target: agentIdByName(db, orgId, params.name) };
    case "owner":
      return { scope: "owner", target: resolveOwner(db, orgId, params.name) };
    case "account": {
      const account = db
        .select({ alias: accounts.alias })
        .from(accounts)
        .where(and(eq(accounts.orgId, orgId), eq(accounts.alias, params.name)))
        .get();
      if (!account) throw new TargetNotFound(`no account named "${params.name}"`);
      return { scope: "account", target: account.alias };
    }
  }
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
    case "agent.workdirs":
      return adminOk(
        setWorkRoots(
          db,
          orgId,
          request.params.name,
          request.params.workRoots,
          deps.home === undefined ? [] : [deps.home],
        ),
      );
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
      const { provider, alias, owner, credential, url, stdio, oauth, http, cli } = request.params;
      const ownerId = resolveOwner(db, orgId, owner);
      const input = {
        orgId,
        ownerId,
        provider,
        alias,
        ...(credential ? { credential } : {}),
        ...(url === undefined ? {} : { url }),
        ...(stdio === undefined ? {} : { stdio }),
        ...(oauth === undefined ? {} : { oauth }),
        ...(http === undefined ? {} : { http }),
        ...(cli === undefined ? {} : { cli }),
      };
      const connected = connectAccount(db, deps.vault, input, now);
      // Gmail, Calendar and Outlook sign in from the Connections page, which
      // needs the operator's own client: say whether that's possible yet. With
      // the vault closed nobody can sign in, client or not, so say nothing.
      const signIn =
        deps.signIns === undefined || deps.vault === null || signInSetupFor(provider) === null
          ? null
          : missingSignInSetup(provider, deps.signIns) === null
            ? "ready"
            : "needs_setup";
      return adminOk({ ...connected, signIn });
    }
    case "account.list":
      return adminOk(listAccounts(db, orgId));
    case "account.configure": {
      const { alias, credentialHosts, credentialAuth, credentialDelivery, credential } =
        request.params;
      const configured = configureAccount(db, deps.vault, orgId, alias, {
        credentialHosts,
        credentialAuth,
        credentialDelivery,
        credential,
      });
      // A running server holds whatever it started with; it starts again on its next call.
      deps.onAccountConfigured?.(configured.accountId);
      return adminOk(configured);
    }
    case "account.share":
    case "account.unshare": {
      const { alias, kind, name } = request.params;
      if (request.method === "account.share") shareAccount(db, orgId, alias, { kind, name }, now);
      else unshareAccount(db, orgId, alias, { kind, name });
      return adminOk(sharingOf(db, orgId, alias));
    }
    case "account.approvers": {
      const { alias, repo, approvers } = request.params;
      setApprovers(db, orgId, alias, repo, approvers, now);
      return adminOk(sharingOf(db, orgId, alias));
    }
    case "account.sharing":
      return adminOk(sharingOf(db, orgId, request.params.alias));
    case "user.enroll": {
      const enrollment = createEnrollment(db, {
        orgId,
        userName: request.params.name,
        publicUrl: deps.publicUrl,
        now,
      });
      // On a team install, say whose IdP identity this name is, so the admin enrolls the right person.
      const subject =
        db
          .select({ subject: users.oidcSubject })
          .from(users)
          .where(and(eq(users.orgId, orgId), eq(users.name, request.params.name)))
          .get()?.subject ?? null;
      return adminOk({
        url: enrollment.url,
        expiresAt: enrollment.expiresAt.toISOString(),
        activeFrom: enrollment.activeFrom?.toISOString() ?? null,
        subject,
      });
    }
    case "user.email": {
      const { name, email } = request.params;
      if (!setUserEmail(db, orgId, name, email)) {
        return adminError("not_found", `no user named "${name}"`);
      }
      return adminOk({ name, email });
    }
    case "pause": {
      const key = pauseKeyFor(db, orgId, request.params);
      return adminOk({ ...key, ...pause(db, orgId, key, ADMIN_SOCKET_ACTOR, now) });
    }
    case "pause.list":
      return adminOk(
        listPauses(db, orgId).map((row) => ({
          scope: row.scope,
          target: row.target,
          pausedBy: row.pausedBy,
          pausedAt: row.pausedAt.toISOString(),
        })),
      );
    case "standing.revoke": {
      const revoked = revokeStanding(db, orgId, request.params.id, null, now);
      if (revoked.ok) return adminOk({ id: request.params.id, revoked: true });
      return revoked.reason === "not_found"
        ? adminError("not_found", `no standing approval "${request.params.id}"`)
        : adminError("conflict", `standing approval "${request.params.id}" is already revoked`);
    }
    case "standing.list":
      return adminOk(
        listStanding(db, orgId).map(({ row, agentName, account, covers }) => ({
          id: row.id,
          agent: agentName,
          account,
          scope: row.scope,
          covers,
          rule: row.rule,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          revokedAt: row.revokedAt?.toISOString() ?? null,
        })),
      );
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
      if (error instanceof SharingError) {
        return adminError(error.code === "invalid" ? "invalid" : "not_found", error.message);
      }
      if (error instanceof OwnerNotFound || error instanceof TargetNotFound) {
        return adminError("not_found", error.message);
      }
      if (error instanceof EnrollmentError) {
        return adminError(error.code === "unknown_user" ? "not_found" : "conflict", error.message);
      }
      throw error;
    }
  };
}
