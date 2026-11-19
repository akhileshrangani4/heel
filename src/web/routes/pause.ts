import { Hono } from "hono";
import { PAUSE_SCOPES, type PauseScope } from "../../core/call.ts";
import { findPause, listPauses, pause, resume } from "../../store/pauses.ts";
import { resumeBinding, resumeFromBinding } from "../decisions.ts";
import {
  formField,
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
 * Pause and resume (spec: Pause, Q-N5). Pausing is one tap on a plain form
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

function activePauses(deps: HumanPlaneDeps): ActivePause[] {
  return listPauses(deps.db, deps.orgId).map((row) => ({
    scope: row.scope,
    target: pauseTargetName(deps.db, row),
    pausedBy: pausedByName(deps.db, row.pausedBy),
    pausedAt: row.pausedAt,
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
          active: activePauses(deps),
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
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "resume",
      userId: session.userId,
      binding: resumeBinding(resumeRequest),
      now: deps.now(),
    });
    if (!issued.ok) return c.json({ ok: false, message: "You have no passkey enrolled." }, 400);
    return c.json(issued);
  });

  app.post("/pause/resume", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "resume",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now: deps.now(),
    });
    if (!verified.ok) return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    // What to resume comes from the signed challenge, never from this request's body.
    const resumeRequest = resumeFromBinding(verified.binding);
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
