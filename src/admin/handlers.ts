import { and, count, eq } from "drizzle-orm";
import { exportAuditPage } from "../audit/export.ts";
import type { CodeModeHealth } from "../codemode/self-test.ts";
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
  workRootsByName,
} from "../gateway/agents.ts";
import { describeProposal, orgPendingProposals } from "../proposals/rules.ts";
import { orgPendingRequests, serviceLabel } from "../requests/connection.ts";
import { readActivity } from "../store/activity.ts";
import { listOrgApprovals, listStanding, revokeStanding } from "../store/approvals.ts";
import type { HeelDb } from "../store/db.ts";
import { LOCAL_OWNER_NAME } from "../store/install.ts";
import { setUserEmail } from "../store/notifications.ts";
import { ADMIN_SOCKET_ACTOR, listPauses, type PauseKey, pause } from "../store/pauses.ts";
import { addPerson } from "../store/people.ts";
import { accounts, agents, passkeys, pushSubscriptions, users } from "../store/schema.ts";
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
import { removeAccount, setAccountCredential } from "../vault/manage.ts";
import type { Vault } from "../vault/vault.ts";
import { createEnrollment, EnrollmentError } from "../web/passkeys.ts";
import {
  emailPreviewFrom,
  headline,
  httpPreviewFrom,
  mergePreviewFrom,
} from "../web/ui/summary.ts";
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
  /** heel's own state directory; no agent work root may overlap it. */
  home?: string;
  /** `heel account set` changed how an account's server runs: stop the one running now. */
  onAccountConfigured?: (accountId: string) => void;
  /**
   * Which sign-in clients (`providers.google`, `providers.microsoft`) heel
   * started with, so `heel connect gmail` can say when its owner can't sign
   * in yet. Left out, connect says nothing about it.
   */
  signIns?: ConfiguredSignIns;
  /**
   * Background code-mode scripts: listed by `heel status`, and stopped
   * when their agent is revoked or its token rotated. Absent without code mode.
   */
  backgroundScripts?: {
    list(): readonly { id: string; agentName: string; status: string; calls: number }[];
    stopAgent(agentId: string): void;
  };
  /**
   * Whether code mode can run, from the check heel makes as the agent plane
   * starts (`codemode/self-test.ts`): shown by `heel status`. Null, or left
   * out, when the agent plane isn't up.
   */
  codeMode?: () => CodeModeHealth | null;
  /** Started by `heel start` (it sets HEEL_BACKGROUND=1), so `heel update` may restart it. */
  background?: boolean;
  /** People sign in with an IdP: they join by signing in, so `heel user add` is refused. */
  teamSignIn?: boolean;
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

/**
 * Gmail, Calendar and Outlook sign in from the Connections page, which needs
 * the operator's own client: whether that's possible yet. Null for other
 * providers, and while the vault is closed, when nobody can sign in at all.
 */
function signInState(deps: AdminDeps, provider: string): "ready" | "needs_setup" | null {
  if (deps.signIns === undefined || deps.vault === null || signInSetupFor(provider) === null) {
    return null;
  }
  return missingSignInSetup(provider, deps.signIns) === null ? "ready" : "needs_setup";
}

/** Stops a revoked or rotated agent's background scripts. */
function stopScriptsOf(deps: AdminDeps, db: HeelDb, orgId: string, name: string): void {
  const agent = db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.orgId, orgId), eq(agents.name, name)))
    .get();
  if (agent !== undefined) deps.backgroundScripts?.stopAgent(agent.id);
}

function dispatch(deps: AdminDeps, request: AdminRequest, now: Date): AdminResponse {
  const { db, orgId } = deps;
  switch (request.method) {
    case "ping":
      return adminOk({
        version: deps.version,
        vault: deps.vault ? "open" : "unavailable",
        // For `heel stop` and `heel update`: which process to signal, and
        // whether it runs in the background where heel may restart it.
        pid: process.pid,
        background: deps.background ?? false,
        // For `heel status`, and an agent setting heel up: whether anyone can approve yet.
        passkeys:
          db.select({ n: count() }).from(passkeys).where(eq(passkeys.orgId, orgId)).get()?.n ?? 0,
        notifiedDevices:
          db
            .select({ n: count() })
            .from(pushSubscriptions)
            .where(eq(pushSubscriptions.orgId, orgId))
            .get()?.n ?? 0,
        // For `heel status`: a heel whose code mode can't run says so, not just "running".
        codeMode: deps.codeMode?.() ?? null,
      });
    case "agent.add": {
      const ownerId = resolveOwner(db, orgId, request.params.owner);
      const { name, expiresInDays } = request.params;
      return adminOk(
        addAgent(
          db,
          { orgId, ownerId, name, ...(expiresInDays === undefined ? {} : { expiresInDays }) },
          now,
        ),
      );
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
    case "agent.workdirs.list":
      return adminOk(workRootsByName(db, orgId, request.params.name));
    case "agent.rotate": {
      const rotated = rotateAgentToken(
        db,
        orgId,
        request.params.name,
        now,
        request.params.expiresInDays,
      );
      // Scripts started with the old token stop now, rather than at their next call.
      stopScriptsOf(deps, db, orgId, request.params.name);
      return adminOk(rotated);
    }
    case "agent.revoke":
      revokeAgent(db, orgId, request.params.name, now);
      stopScriptsOf(deps, db, orgId, request.params.name);
      return adminOk({ name: request.params.name, revoked: true });
    case "scripts.list":
      return adminOk(deps.backgroundScripts?.list() ?? []);
    case "agent.list":
      return adminOk(
        listAgents(db, orgId).map((agent) => ({
          ...agent,
          tokenExpiresAt: agent.tokenExpiresAt?.toISOString() ?? null,
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
      return adminOk({ ...connected, signIn: signInState(deps, provider) });
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
    case "account.credential": {
      const { alias, credential } = request.params;
      const set = setAccountCredential(db, deps.vault, orgId, alias, credential);
      // A local server holds the credential it started with; it starts again on its next call.
      deps.onAccountConfigured?.(set.accountId);
      return adminOk(set);
    }
    case "account.remove": {
      const removed = removeAccount(db, orgId, request.params.alias, now);
      deps.onAccountConfigured?.(removed.accountId);
      return adminOk(removed);
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
    case "user.add": {
      if (deps.teamSignIn === true) {
        return adminError(
          "invalid",
          "people join this heel by signing in with its sign-in provider, not by name",
        );
      }
      const added = addPerson(db, orgId, request.params.name, now);
      if (!added.ok) return adminError("invalid", added.problem);
      return adminOk({ name: request.params.name });
    }
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
    case "approvals.list": {
      return adminOk(
        listOrgApprovals(db, orgId, now).map(({ row, agentName, status }) => {
          const said = headline({
            agent: agentName,
            action: row.call.action ?? null,
            tool: row.tool,
            account: row.account,
            email: emailPreviewFrom(row.call.action ?? null, row.call.args),
            merge: mergePreviewFrom(row.call.action ?? null, row.call.args),
            http: httpPreviewFrom(row.call),
          });
          return {
            id: row.id,
            agent: agentName,
            account: row.account,
            status,
            summary: `${said.agent} wants to ${said.action} ${said.preposition} ${said.place}${said.rest}`,
            reason: row.reason,
            createdAt: row.createdAt.toISOString(),
            expiresAt: row.expiresAt.toISOString(),
            url: new URL(`/approvals/${encodeURIComponent(row.id)}`, deps.publicUrl).href,
          };
        }),
      );
    }
    case "proposals.list": {
      // Rule proposals and connection requests: everything agents asked their owners for.
      const proposals = orgPendingProposals(db, orgId, now).map(
        ({ row, agentName, ownerName }) => ({
          id: row.id,
          agent: agentName,
          owner: ownerName,
          rules: row.rules.length,
          hide: row.hide.length,
          workdirs: row.workdirs.length,
          summary: `${agentName} proposes ${describeProposal(row.rules.length, row.hide.length, row.workdirs.length)}${row.rules.length + row.hide.length > 0 ? ` for ${ownerName}'s rules` : " for its heel run"}`,
          reason: row.reason,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
          url: new URL(`/proposals/${encodeURIComponent(row.id)}`, deps.publicUrl).href,
        }),
      );
      const requests = orgPendingRequests(db, orgId, now).map(({ row, agentName, ownerName }) => ({
        id: row.id,
        agent: agentName,
        owner: ownerName,
        rules: 0,
        hide: 0,
        summary: `${agentName} asks ${ownerName} to connect ${serviceLabel(row.details)} as ${row.details.alias}`,
        reason: row.why,
        createdAt: row.createdAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        url: new URL(`/requests/${encodeURIComponent(row.id)}`, deps.publicUrl).href,
      }));
      return adminOk(
        [...proposals, ...requests].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
      );
    }
    case "activity.list": {
      const { afterId, limit } = request.params;
      return adminOk(
        readActivity(db, { orgId, ownerIds: null, afterId, limit }).map((row) => ({
          id: row.id,
          at: row.at.toISOString(),
          kind: row.kind,
          mode: row.mode,
          agentId: row.agentId,
          account: row.account,
          action: row.action ?? row.tool,
          rule: row.rule === null ? null : (row.rule.name ?? `${row.rule.file}:${row.rule.line}`),
          reason: row.reason,
        })),
      );
    }
    case "pause.list": {
      // Agents and owners are stored by id; people read them by name.
      const agentNames = new Map(listAgents(db, orgId).map((a) => [a.id, a.name]));
      const ownerNames = new Map(
        db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(eq(users.orgId, orgId))
          .all()
          .map((u) => [u.id, u.name]),
      );
      const nameOf = (scope: string, target: string): string =>
        scope === "agent"
          ? (agentNames.get(target) ?? target)
          : scope === "owner"
            ? (ownerNames.get(target) ?? target)
            : scope === "global"
              ? "everything"
              : target;
      return adminOk(
        listPauses(db, orgId).map((row) => ({
          scope: row.scope,
          target: row.target,
          targetName: nameOf(row.scope, row.target),
          pausedBy: row.pausedBy,
          pausedAt: row.pausedAt.toISOString(),
        })),
      );
    }
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
