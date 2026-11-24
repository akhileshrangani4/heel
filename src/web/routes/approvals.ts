import { Hono } from "hono";
import { stopParked } from "../../codemode/parking.ts";
import {
  type ApprovalRecord,
  approverIds,
  type DecideResult,
  decideApproval,
  getApproval,
  listApprovalsFor,
} from "../../store/approvals.ts";
import { foldsFor, isFoldName, rememberFold } from "../../store/folds.ts";
import { hintsFor } from "../../store/hints.ts";
import { type Decision, decisionBinding, decisionFromBinding } from "../decisions.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  renderPage,
  requireCsrfField,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
  viewerOf,
} from "../http.ts";
import { pendingRecoveries } from "../passkeys.ts";
import { pauseNoticeFor } from "../pause-targets.ts";
import type { SessionView } from "../sessions.ts";
import { type ApprovalRequestView, approvalRequest, foldKind } from "../ui/approval-request.ts";
import { clientScript } from "../ui/client.ts";
import { recoveryNotices } from "../ui/devices.ts";
import { html } from "../ui/html.ts";
import { type PendingRow, pendingList } from "../ui/pending-list.ts";
import { suggestionCards } from "../ui/suggestions.ts";
import {
  emailPreviewFrom,
  headline,
  httpPreviewFrom,
  mailPreviewFrom,
  mergePreviewFrom,
} from "../ui/summary.ts";
import { proposalCardsFor } from "./proposals.ts";
import { requestCardsFor } from "./requests.ts";
import { suggestionsOf } from "./suggestions.ts";

/**
 * The approval page (spec: The approval page). A person sees every request
 * they may decide, and decides one with a fresh passkey assertion:
 *
 * - `GET /approvals` lists requests waiting on, or recently decided by, them.
 * - `GET /approvals/:id` shows one request in full: agent, account, the rule
 *   that asked, and the exact arguments that will run.
 * - `POST /approvals/:id/challenge` issues a challenge naming the exact
 *   decision (see decisions.ts).
 * - `POST /approvals/folds` remembers which sections of the page a person
 *   keeps open for a kind of request. Presentation only; it decides nothing.
 * - `POST /approvals/:id/decide` verifies the signed challenge and records
 *   the decision it names. Approving runs nothing (I-53): the call runs only
 *   when the agent re-sends it.
 *
 * Someone who may not decide a request gets "not found", the same as for a
 * request that doesn't exist, so ids can't be probed.
 */

const DECIDE_HANDLER = { handler: "decide" } as const;

/** What the person reads when a decision is refused. */
const REFUSED: Record<Extract<DecideResult, { ok: false }>["reason"], string> = {
  not_found: "That request no longer exists.",
  hash_mismatch: "The request changed since this page loaded. Reload it and look again.",
  not_pending: "This request was already decided, ran, or expired.",
  paused: "A pause covers this request. Resume first; you can still deny it.",
  not_approver: "You aren't an approver for this request.",
  org_ask_cannot_stand: "An organization ask can be approved once, never as standing.",
  no_run: "This request came without a run id, so it can't be approved for its run.",
};

function mayDecide(deps: HumanPlaneDeps, session: SessionView, record: ApprovalRecord): boolean {
  return approverIds(deps.db, record.row).includes(session.userId);
}

/** The request as the page shows it. Everything comes from the stored, normalized call. */
function requestView(
  record: ApprovalRecord,
  hints: ApprovalRequestView["hints"] = [],
): ApprovalRequestView {
  const { row } = record;
  return {
    id: row.id,
    callHash: row.callHash,
    status: record.status,
    origin: row.origin,
    agent: record.agentName,
    runId: row.runId,
    account: row.account,
    provider: row.call.provider,
    surface: row.call.surface,
    tool: row.tool,
    action: row.call.action ?? null,
    rule: row.rule,
    reason: row.reason,
    script: row.script ?? null,
    client: row.client,
    args: row.call.args,
    // Built from the stored call, never from what the agent said about it.
    email: mailPreviewFrom(row.call.action ?? null, row.call.args),
    merge: mergePreviewFrom(row.call.action ?? null, row.call.args),
    http: httpPreviewFrom(row.call),
    items: row.call.items,
    counts: [],
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    decision:
      row.decidedAt === null ? null : { by: record.decidedByName ?? "unknown", at: row.decidedAt },
    executedAt: row.executedAt,
    hints,
  };
}

/** Stored hints, plus "on the way" for a configured adapter that hasn't answered a pending request. */
function pageHints(deps: HumanPlaneDeps, record: ApprovalRecord): ApprovalRequestView["hints"] {
  const stored = hintsFor(deps.db, record.row.id);
  if (record.status !== "pending") return stored;
  const waiting = (deps.hintAdapters ?? [])
    .filter((name) => !stored.some((s) => s.adapter === name))
    .map((adapter) => ({ adapter, result: { status: "pending" as const } }));
  return [...stored, ...waiting];
}

function pendingRow(deps: HumanPlaneDeps, record: ApprovalRecord): PendingRow {
  const { row } = record;
  return {
    id: row.id,
    href: `/approvals/${encodeURIComponent(row.id)}`,
    status: record.status,
    origin: row.origin,
    agent: record.agentName,
    account: row.account,
    action: row.call.action ?? null,
    tool: row.tool,
    rule: row.rule,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    pausedBy: pauseNoticeFor(deps.db, row.call),
    // The same sentence the request page leads with, built from the stored call.
    headline: headline({
      agent: record.agentName,
      action: row.call.action ?? null,
      tool: row.tool,
      account: row.account,
      email: emailPreviewFrom(row.call.action ?? null, row.call.args),
      merge: mergePreviewFrom(row.call.action ?? null, row.call.args),
      http: httpPreviewFrom(row.call),
    }),
    client: row.client,
    reason: row.reason,
  };
}

/** Reads the decision the page asked to make. Invalid input is null, never a guess. */
function requestedDecision(
  approvalId: string,
  body: Record<string, unknown> | null,
): Decision | null {
  const standing = body?.["standing"];
  const choice =
    typeof standing === "object" && standing !== null
      ? (standing as Record<string, unknown>)
      : null;
  // Round-tripping through the binding validates every field in one place.
  return decisionFromBinding({
    approvalId,
    callHash: stringField(body, "callHash") ?? "",
    intent: stringField(body, "intent") ?? "",
    standingScope: stringField(choice, "scope") ?? "",
    standingDuration: stringField(choice, "duration") ?? "",
  });
}

export function approvalRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  const csrf = requireCsrfHeader();

  /**
   * Recovery links waiting to work, for the person they're for or an admin.
   * On the list and on each request, since notifications link straight to one.
   */
  function recoveriesFor(session: SessionView, now: Date) {
    return recoveryNotices(
      pendingRecoveries(deps.db, deps.orgId, now).filter(
        (r) => r.userId === session.userId || session.role === "admin",
      ),
      now,
      { action: "/enroll/recoveries/cancel", csrfToken: session.csrfToken },
    );
  }

  app.get("/approvals", signedIn, (c) => {
    const session = c.get("session");
    const now = deps.now();
    const rows = listApprovalsFor(deps.db, session, now).map((r) => pendingRow(deps, r));
    const changes = proposalCardsFor(deps, session, now);
    const asks = requestCardsFor(deps, session, now);
    const suggested = suggestionCards(
      suggestionsOf(deps, session, now),
      session.csrfToken,
      "approvals",
    );
    return renderPage(c, {
      title: "Approvals",
      viewer: viewerOf(session),
      current: "approvals",
      body: html`${recoveriesFor(session, now)}
      ${suggested}
      ${pendingList({ now, load: { ok: true, rows }, ruleChangesWaiting: changes.count + asks.count })}
      ${asks.cards}
      ${changes.cards}
`,
      script: clientScript(session.csrfToken),
    });
  });

  app.get("/approvals/:id", signedIn, (c) => {
    const session = c.get("session");
    const now = deps.now();
    const record = getApproval(deps.db, deps.orgId, c.req.param("id"), now);
    if (record === null || !mayDecide(deps, session, record)) {
      return renderPage(
        c,
        {
          title: "Not found",
          viewer: viewerOf(session),
          current: "approvals",
          body: html`<h1>Not found</h1>
            <p>There's no request with that id that you can decide.</p>`,
        },
        404,
      );
    }
    const pause = pauseNoticeFor(deps.db, record.row.call);
    const view = requestView(record, pageHints(deps, record));
    return renderPage(c, {
      title: `Request from ${record.agentName}`,
      viewer: viewerOf(session),
      current: "approvals",
      pause,
      body: html`${recoveriesFor(session, now)}
      ${approvalRequest({
        now,
        load: { ok: true, request: view },
        pause,
        onDecide: DECIDE_HANDLER,
        folds: foldsFor(deps.db, session.userId, foldKind(view)),
        background: deps.background?.waitsOn(record.row.id) === true,
      })}`,
      script: clientScript(session.csrfToken),
    });
  });

  app.post("/approvals/folds", signedIn, csrf, async (c) => {
    const body = await jsonBody(c);
    const kind = stringField(body, "kind");
    const section = stringField(body, "section");
    const open = body?.["open"];
    if (kind === undefined || section === undefined || typeof open !== "boolean") {
      return c.json({ ok: false, message: "Expected kind, section and open." }, 400);
    }
    if (!isFoldName(kind) || !isFoldName(section)) {
      return c.json({ ok: false, message: "That isn't a section heel shows." }, 400);
    }
    rememberFold(deps.db, { userId: c.get("session").userId, kind, section, open }, deps.now());
    return c.json({ ok: true });
  });

  // Stopping a parked script only takes something away, so it's a plain form, no passkey.
  app.post("/approvals/:id/stop-script", signedIn, requireCsrfField(), (c) => {
    const session = c.get("session");
    const record = getApproval(deps.db, deps.orgId, c.req.param("id"), deps.now());
    if (record === null || !mayDecide(deps, session, record)) {
      return c.text(REFUSED.not_found, 404);
    }
    const stopped = stopParked(deps.db, deps.orgId, record.row.id);
    // A background script waiting on it ends too, so its agent's one slot frees up (C6).
    deps.background?.stopWaitingOn(record.row.id);
    if (stopped > 0) {
      deps.log.info({ approval: record.row.id, by: session.userId }, "parked script stopped");
    }
    return c.redirect(`/approvals/${encodeURIComponent(record.row.id)}?script-stopped`, 303);
  });

  app.post("/approvals/:id/challenge", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const now = deps.now();
    const record = getApproval(deps.db, deps.orgId, c.req.param("id"), now);
    if (record === null || !mayDecide(deps, session, record)) {
      return c.json({ ok: false, message: REFUSED.not_found }, 404);
    }
    const decision = requestedDecision(record.row.id, await jsonBody(c));
    if (decision === null)
      return c.json({ ok: false, message: "That isn't a decision heel knows." }, 400);
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "decide",
      userId: session.userId,
      binding: decisionBinding(decision),
      now,
    });
    if (!issued.ok) {
      return c.json(
        { ok: false, message: "You have no passkey enrolled. Run heel user enroll." },
        400,
      );
    }
    return c.json(issued);
  });

  app.post("/approvals/:id/decide", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const now = deps.now();
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "decide",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now,
    });
    if (!verified.ok) {
      deps.log.info({ reason: verified.reason }, "decision passkey check refused");
      return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    }
    // The decision comes from the signed challenge, never from this request's body.
    const decision = decisionFromBinding(verified.binding);
    if (decision === null || decision.approvalId !== c.req.param("id")) {
      return c.json({ ok: false, message: "That passkey check was for something else." }, 400);
    }
    const result = decideApproval(deps.db, deps.approvals, deps.pauses, {
      approver: session,
      ...decision,
      now,
    });
    if (!result.ok) return c.json({ ok: false, message: REFUSED[result.reason] }, 409);
    // After the decision has committed: a background script parked on it resumes or ends (C6).
    const resumesScript = deps.background?.waitsOn(decision.approvalId) === true;
    deps.background?.approvalDecided(decision.approvalId);
    deps.log.info(
      {
        approvalId: decision.approvalId,
        status: result.status,
        standing: result.standingApprovalId,
      },
      "approval decided",
    );
    return c.json({
      ok: true,
      message:
        result.status === "approved"
          ? resumesScript
            ? "Approved. The task goes on from this step."
            : "Approved. It runs now if the agent is still waiting, or when it sends the call again."
          : resumesScript
            ? "Denied. The task has ended."
            : "Denied.",
      next: `/approvals/${encodeURIComponent(decision.approvalId)}`,
    });
  });

  return app;
}
