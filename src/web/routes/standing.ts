import { Hono } from "hono";
import { standingState } from "../../core/approvals.ts";
import type { RuleSet } from "../../core/rules/evaluate.ts";
import type { HeelQuery } from "../../gateway/pipeline/ports.ts";
import { listStanding, revokeStanding, type StandingRecord } from "../../store/approvals.ts";
import { findAccount } from "../../store/directory.ts";
import { accountApproverIds } from "../../store/sharing.ts";
import {
  formField,
  type HumanPlaneDeps,
  renderPage,
  requireCsrfField,
  requireSession,
  type SignedInEnv,
  viewerOf,
} from "../http.ts";
import { pauseNoticeFor } from "../pause-targets.ts";
import type { SessionView } from "../sessions.ts";
import { type StandingRow, standingApprovalList } from "../ui/standing-approval-list.ts";

/**
 * Standing approvals (spec: Standing approvals). They live in the store,
 * never in YAML. A person sees the ones on their own agents (an admin sees
 * all) and can revoke one with a plain form: revoking only tightens, so it
 * needs no passkey, and it takes effect on the next call.
 *
 * - `GET /standing` lists them with their state.
 * - `POST /standing/:id/revoke` revokes one.
 */

/** Content hashes of every rule in force: a standing approval whose rule isn't here has lapsed (I-16). */
function liveRuleHashes(set: RuleSet | null): Set<string> {
  if (set === null) return new Set();
  const files = [...(set.org === null ? [] : [set.org]), ...set.owners.values()];
  return new Set(files.flatMap((file) => file.rules.map((rule) => rule.hash)));
}

/**
 * Who sees and may revoke a standing approval: admins, the agent's owner,
 * the person who granted it, and, on a shared account, that account's
 * owner and approvers (D13b), since it answers asks they decide.
 */
function visibleTo(db: HeelQuery, session: SessionView, record: StandingRecord): boolean {
  if (session.role === "admin" || record.ownerId === session.userId) return true;
  if (record.row.createdBy === session.userId) return true;
  if (findAccount(db, session.orgId, record.account)?.ownerId === session.userId) return true;
  return accountApproverIds(db, session.orgId, record.account, record.call.repo).includes(
    session.userId,
  );
}

export function standingRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  app.get("/standing", signedIn, (c) => {
    const session = c.get("session");
    const now = deps.now();
    const live = liveRuleHashes(deps.rules.set);
    const rows: StandingRow[] = listStanding(deps.db, deps.orgId)
      .filter((record) => visibleTo(deps.db, session, record))
      .map((record) => ({
        id: record.row.id,
        agent: record.agentName,
        account: record.account,
        scope: record.row.scope,
        rule: record.row.rule,
        covers:
          record.row.scope === "exact_call"
            ? record.covers
            : record.row.scope === "run"
              ? record.row.runId
              : null,
        createdBy: record.createdByName,
        createdAt: record.row.createdAt,
        expiresAt: record.row.expiresAt,
        state: standingState(record.row, live, now),
        revoked:
          record.row.revokedAt === null
            ? null
            : { by: record.revokedByName ?? "the admin socket", at: record.row.revokedAt },
        paused: pauseNoticeFor(deps.db, record.call) !== null,
      }));
    return renderPage(c, {
      title: "Standing approvals",
      viewer: viewerOf(session),
      current: "standing",
      body: standingApprovalList({
        now,
        load: { ok: true, rows },
        revokeForm: { action: "/standing/revoke", csrfToken: session.csrfToken },
      }),
    });
  });

  app.post("/standing/revoke", signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const id = (await formField(c, "id")) ?? "";
    const record = listStanding(deps.db, deps.orgId).find((r) => r.row.id === id);
    if (record === undefined || !visibleTo(deps.db, session, record)) {
      return c.text("Refused: no such standing approval.", 404);
    }
    revokeStanding(deps.db, deps.orgId, id, session.userId, deps.now());
    return c.redirect("/standing", 303);
  });

  return app;
}
