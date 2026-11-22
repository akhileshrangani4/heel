import { Hono } from "hono";
import type { LearnedRule } from "../../core/learning.ts";
import {
  dismissSuggestion,
  type LearningDeps,
  proposeSuggestion,
  suggestionsFor,
} from "../../store/learning.ts";
import {
  type HumanPlaneDeps,
  requireCsrfField,
  requireSession,
  type SignedInEnv,
} from "../http.ts";
import type { SessionView } from "../sessions.ts";

/**
 * Suggested rules (roadmap 2.10). A suggestion is named only by its key: the
 * rule is drafted again from the person's own decisions on every request, so
 * nothing in a form can change what gets proposed.
 *
 * - `POST /suggestions/:key/propose`: opens it as a proposal, then shows it.
 * - `POST /suggestions/:key/dismiss`: stops offering it.
 *
 * Both only draft or hide a draft; adding a rule still takes a passkey on the
 * proposal page.
 */

function learningOf(deps: HumanPlaneDeps): LearningDeps {
  return { db: deps.db, rules: deps.rules.set, threshold: deps.learning ?? null };
}

/** This person's suggestions now, for the Approvals and Activity pages. */
export function suggestionsOf(
  deps: HumanPlaneDeps,
  session: SessionView,
  now: Date,
): LearnedRule[] {
  return suggestionsFor(learningOf(deps), session.userId, now);
}

export function suggestionRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  app.post("/suggestions/:key/propose", signedIn, requireCsrfField(), (c) => {
    const session = c.get("session");
    const outcome = proposeSuggestion(
      learningOf(deps),
      { orgId: deps.orgId, userId: session.userId },
      c.req.param("key"),
      deps.now(),
    );
    if (outcome === null) return c.text("There's no such suggestion for you now.", 404);
    if (!outcome.ok) {
      deps.log.warn(
        { problems: outcome.problems },
        "a suggested rule didn't make a valid proposal",
      );
      return c.text("heel couldn't turn that suggestion into a rule change.", 500);
    }
    deps.log.info({ proposal: outcome.proposalId, by: session.userId }, "suggested rule proposed");
    return c.redirect(`/proposals/${encodeURIComponent(outcome.proposalId)}`, 303);
  });

  app.post("/suggestions/:key/dismiss", signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const dismissed = dismissSuggestion(
      learningOf(deps),
      session.userId,
      c.req.param("key"),
      deps.now(),
    );
    if (!dismissed) return c.text("There's no such suggestion for you now.", 404);
    const form = await c.req.parseBody();
    return c.redirect(form["from"] === "activity" ? "/activity" : "/approvals", 303);
  });

  return app;
}
