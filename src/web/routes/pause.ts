import { Hono } from "hono";
import { PAUSE_SCOPES, type PauseScope } from "../../core/call.ts";
import { findPause, listPauses, pause, resume } from "../../store/pauses.ts";
import { resumeBinding, resumeFromBinding } from "../decisions.ts";
import {
  formField,
  type HumanPlaneDeps,
  jsonBody,
  passkeyChallenge,
  passkeyFailed,
  renderPage,
  requireCsrfField,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
  verifiedBinding,
  viewerOf,
} from "../http.ts";
import {
  mayPause,
  mayResume,
  pausableTargets,
  pausedByName,
  pauseKeyByName,
  pauseTargetName,
} from "../pause-targets.ts";
import type { SessionView } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { type ActivePause, type PauseOutcome, pauseControl } from "../ui/pause-control.ts";

/**
 * Pause and resume. Pausing is one tap on a plain form
 * with no passkey, because it can only stop calls. Resuming lets calls run
 * again, so it takes a fresh passkey assertion naming the pause.
 *
 * - `GET /pause` shows what is paused and what this person may pause.
 * - `POST /pause` pauses one scope (form post).
 * - `POST /pause/resume/challenge` and `POST /pause/resume` resume one,
 *   with the same challenge-then-verify steps as a decision.
 */

function isPauseScope(value: unknown): value is PauseScope {
  return (PAUSE_SCOPES as readonly unknown[]).includes(value);
}

/** The result of the last pause or resume, carried in the redirect's query string. */
/**
 * The notice after a pause or resume, from the redirect's query. The target
 * must name something real (an agent, account or person here; a provider
 * id), so a crafted link can't make heel's notice say something else.
 */
function outcomeFrom(deps: HumanPlaneDeps, query: Record<string, string>): PauseOutcome {
  const scope = query["scope"];
  if (!isPauseScope(scope)) return { kind: "none" };
  const target = query["target"] || null;
  if (scope === "provider" && !/^[a-z0-9][a-z0-9:-]{0,63}$/.test(target ?? "")) {
    return { kind: "none" };
  }
  if (scope !== "global" && pauseKeyByName(deps.db, deps.orgId, scope, target ?? "") === null) {
    return { kind: "none" };
  }
  switch (query["done"]) {
    case "paused":
      return { kind: "paused", scope, target };
    case "resumed":
      return { kind: "resumed", scope, target };
    default:
      return { kind: "none" };
  }
}

function outcomeHref(done: "paused" | "resumed", scope: PauseScope, target: string): string {
  return `/pause?${new URLSearchParams({ done, scope, target })}`;
}

/**
 * The pauses this person may see: all of them for an admin; for a member,
 * the ones covering their own agents, accounts or themselves, and the
 * org-wide ones (everything, a provider) that stop their calls too. Others'
 * pauses would show agents and accounts the member can't otherwise see.
 */
function activePauses(deps: HumanPlaneDeps, session: SessionView): ActivePause[] {
  return listPauses(deps.db, deps.orgId)
    .filter(
      (row) =>
        session.role === "admin" ||
        row.scope === "global" ||
        row.scope === "provider" ||
        mayPause(deps.db, session, row),
    )
    .map((row) => ({
      scope: row.scope,
      target: pauseTargetName(deps.db, row),
      pausedBy: pausedByName(deps.db, row.pausedBy),
      pausedAt: row.pausedAt,
      canResume: mayResume(deps.db, session, row),
    }));
}

/** The pause a resume names, if it exists and this person may lift it. */
function resumable(deps: HumanPlaneDeps, session: SessionView, scope: PauseScope, name: string) {
  const key = pauseKeyByName(deps.db, deps.orgId, scope, name);
  const row = key === null ? null : findPause(deps.db, deps.orgId, key);
  if (row === null || !mayResume(deps.db, session, row)) return null;
  return row;
}

export function pauseRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  const csrf = requireCsrfHeader();

  app.get("/pause", signedIn, (c) => {
    const session = c.get("session");
    return renderPage(c, {
      title: "Pause",
      viewer: viewerOf(session),
      current: "pause",
      body: pauseControl({
        outcome: outcomeFrom(deps, c.req.query()),
        load: {
          ok: true,
          active: activePauses(deps, session),
          ...pausableTargets(deps.db, session),
          canPauseAll: session.role === "admin",
        },
        pauseForm: { action: "/pause", csrfToken: session.csrfToken },
        onResume: { handler: "resume" },
      }),
      script: clientScript(session.csrfToken),
    });
  });

  app.post("/pause", signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const scope = await formField(c, "scope");
    const target = (await formField(c, "target")) ?? "";
    const key = isPauseScope(scope) ? pauseKeyByName(deps.db, deps.orgId, scope, target) : null;
    if (key === null || !mayPause(deps.db, session, key)) {
      return c.text("Refused: you can't pause that.", 403);
    }
    pause(deps.db, deps.orgId, key, session.userId, deps.now());
    deps.log.warn(
      { scope: key.scope, target, by: session.userId },
      "paused from the approval page",
    );
    return c.redirect(outcomeHref("paused", key.scope, target), 303);
  });

  app.post("/pause/resume/challenge", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const resumeRequest = resumeFromBinding({
      scope: stringField(body, "scope") ?? "",
      target: stringField(body, "target") ?? "",
    });
    if (
      resumeRequest === null ||
      resumable(deps, session, resumeRequest.scope, resumeRequest.target) === null
    ) {
      return c.json({ ok: false, message: "That pause isn't there, or isn't yours to lift." }, 404);
    }
    return passkeyChallenge(c, deps, "resume", resumeBinding(resumeRequest));
  });

  app.post("/pause/resume", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const binding = await verifiedBinding(c, deps, "resume");
    if (binding === null) return passkeyFailed(c);
    // What to resume comes from the signed challenge, never from this request's body.
    const resumeRequest = resumeFromBinding(binding);
    const row =
      resumeRequest === null
        ? null
        : resumable(deps, session, resumeRequest.scope, resumeRequest.target);
    if (resumeRequest === null || row === null) {
      return c.json({ ok: false, message: "That pause isn't there, or isn't yours to lift." }, 409);
    }
    resume(deps.db, deps.orgId, row);
    deps.log.warn({ scope: row.scope, by: session.userId }, "resumed from the approval page");
    return c.json({ ok: true, next: outcomeHref("resumed", row.scope, resumeRequest.target) });
  });

  return app;
}
