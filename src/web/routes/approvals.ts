import { Hono } from "hono";
import {
  type ApprovalRecord,
  approverIds,
  type DecideResult,
  decideApproval,
  getApproval,
  listApprovalsFor,
} from "../../store/approvals.ts";
import { hintsFor } from "../../store/hints.ts";
import { type Decision, decisionBinding, decisionFromBinding } from "../decisions.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  renderPage,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
  viewerOf,
} from "../http.ts";
import { pauseNoticeFor } from "../pause-targets.ts";
import type { SessionView } from "../sessions.ts";
import { type ApprovalRequestView, approvalRequest } from "../ui/approval-request.ts";
import { clientScript } from "../ui/client.ts";
import { html } from "../ui/html.ts";
import { type PendingRow, pendingList } from "../ui/pending-list.ts";
import { pushControl } from "../ui/push-control.ts";
import { emailPreviewFrom, mergePreviewFrom } from "../ui/summary.ts";

/**
 * The approval page (spec: The approval page). A person sees every request
 * they may decide, and decides one with a fresh passkey assertion:
 *
 * - `GET /approvals` lists requests waiting on, or recently decided by, them.
 * - `GET /approvals/:id` shows one request in full: agent, account, the rule
 *   that asked, and the exact arguments that will run.
 * - `POST /approvals/:id/challenge` issues a challenge naming the exact
 *   decision (see decisions.ts).
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
    args: row.call.args,
    // Built from the stored call, never from what the agent said about it.
    email: emailPreviewFrom(row.call.action ?? null, row.call.args),
    merge: mergePreviewFrom(row.call.action ?? null, row.call.args),
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

  app.get("/approvals", signedIn, (c) => {
    const session = c.get("session");
    const now = deps.now();
    const rows = listApprovalsFor(deps.db, session, now).map((r) => pendingRow(deps, r));
    return renderPage(c, {
      title: "Approvals",
      viewer: viewerOf(session),
      current: "approvals",
      body: html`${pendingList({ now, load: { ok: true, rows } })}
      ${pushControl({ vapidPublicKey: deps.vapidPublicKey })}`,
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
    return renderPage(c, {
      title: `Request from ${record.agentName}`,
      viewer: viewerOf(session),
      current: "approvals",
      pause,
      body: approvalRequest({
        now,
        load: { ok: true, request: requestView(record, pageHints(deps, record)) },
        pause,
        onDecide: DECIDE_HANDLER,
      }),
      script: clientScript(session.csrfToken),
    });
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
        result.status === "approved" ? "Approved. It runs when the agent re-sends it." : "Denied.",
      next: `/approvals/${encodeURIComponent(decision.approvalId)}`,
    });
  });

  return app;
}
