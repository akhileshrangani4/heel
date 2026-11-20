import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { isStandingDuration, STANDING_DURATIONS } from "../../core/approvals.ts";
import { compileGrant, GrantError } from "../../grants/compile.ts";
import { createGrant, listGrants, revokeGrant } from "../../store/grants.ts";
import { agents, users } from "../../store/schema.ts";
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
import type { SessionView } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { type GrantsOutcome, type GrantView, grantsPage } from "../ui/grants-page.ts";

/**
 * Intent grants on the human plane (A4b).
 *
 * - `GET /grants` lists the grants a person may see: their own agents', or
 *   everyone's for an admin.
 * - `POST /grants/challenge` validates the grant (it must compile, and the
 *   agent must be one the person owns) and issues a passkey challenge bound
 *   to exactly that agent, task, match and duration.
 * - `POST /grants/confirm` creates the grant from the signed challenge,
 *   never from the confirming request's body.
 * - `POST /grants/revoke` revokes one with a plain form.
 */

const MAX_TASK = 500;
/** Grants are for a task, not a standing policy: at most a week. */
const GRANT_DURATIONS = new Set(["1h", "1d", "7d"]);

function mayGrantFor(deps: HumanPlaneDeps, session: SessionView, agentId: string): boolean {
  const row = deps.db
    .select({ ownerId: agents.ownerId })
    .from(agents)
    .where(and(eq(agents.orgId, deps.orgId), eq(agents.id, agentId)))
    .get();
  return row !== undefined && row.ownerId === session.userId;
}

export function grantRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  const csrf = requireCsrfHeader();

  function visible(session: SessionView): GrantView[] {
    const now = deps.now();
    const agentRows = deps.db.select().from(agents).where(eq(agents.orgId, deps.orgId)).all();
    const agentById = new Map(agentRows.map((a) => [a.id, a]));
    const names = new Map(
      deps.db
        .select({ id: users.id, name: users.name })
        .from(users)
        .all()
        .map((u) => [u.id, u.name]),
    );
    return listGrants(deps.db, deps.orgId)
      .filter(
        (g) => session.role === "admin" || agentById.get(g.agentId)?.ownerId === session.userId,
      )
      .map((g) => ({
        id: g.id,
        agent: agentById.get(g.agentId)?.name ?? "unknown",
        task: g.task,
        match: g.match,
        createdBy: names.get(g.createdBy) ?? "unknown",
        createdAt: g.createdAt,
        expiresAt: g.expiresAt,
        state: g.revokedAt !== null ? "revoked" : g.expiresAt <= now ? "expired" : "live",
      }));
  }

  app.get("/grants", signedIn, (c) => {
    const session = c.get("session");
    const query = c.req.query();
    // Only a notice that names a grant of yours in that state: a crafted link
    // can't make the page claim something happened.
    const state = (id: string | undefined) =>
      id === undefined ? undefined : visible(session).find((g) => g.id === id)?.state;
    const outcome: GrantsOutcome =
      state(query["granted"]) === "live"
        ? { kind: "granted" }
        : state(query["revoked"]) === "revoked"
          ? { kind: "revoked" }
          : { kind: "none" };
    const mine = deps.db
      .select({ id: agents.id, name: agents.name })
      .from(agents)
      .where(and(eq(agents.orgId, deps.orgId), eq(agents.ownerId, session.userId)))
      .all();
    return renderPage(c, {
      title: "Grants",
      viewer: viewerOf(session),
      current: "grants",
      body: grantsPage({
        grants: visible(session),
        agents: mine,
        outcome,
        revoke: { action: "/grants/revoke", csrfToken: session.csrfToken },
      }),
      script: clientScript(session.csrfToken),
    });
  });

  app.post("/grants/challenge", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const agent = stringField(body, "agent") ?? "";
    const task = (stringField(body, "task") ?? "").trim();
    const match = (stringField(body, "match") ?? "").trim();
    const duration = stringField(body, "duration") ?? "";
    if (!mayGrantFor(deps, session, agent)) {
      return c.json({ ok: false, message: "You can only grant for your own agents." }, 403);
    }
    if (task === "" || task.length > MAX_TASK) {
      return c.json({ ok: false, message: "Say what the task is, in under 500 characters." }, 400);
    }
    if (!GRANT_DURATIONS.has(duration)) {
      return c.json({ ok: false, message: "Pick how long it lasts." }, 400);
    }
    let canonical: string;
    try {
      canonical = compileGrant(match, { id: "draft" }).canonical;
    } catch (error) {
      if (error instanceof GrantError) return c.json({ ok: false, message: error.message }, 400);
      throw error;
    }
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "grant",
      userId: session.userId,
      // The canonical form is what is signed and stored, so what runs is what was signed.
      binding: { agent, task, match: canonical, duration },
      now: deps.now(),
    });
    if (!issued.ok) return c.json({ ok: false, message: "You have no passkey enrolled." }, 400);
    return c.json(issued);
  });

  app.post("/grants/confirm", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "grant",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now: deps.now(),
    });
    if (!verified.ok) return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    // What to grant comes from the signed challenge, never from this body.
    const { agent, task, match, duration } = verified.binding;
    if (
      typeof agent !== "string" ||
      typeof task !== "string" ||
      typeof match !== "string" ||
      !isStandingDuration(duration) ||
      !GRANT_DURATIONS.has(duration) ||
      !mayGrantFor(deps, session, agent)
    ) {
      return c.json({ ok: false, message: "That grant isn't yours to make." }, 409);
    }
    const now = deps.now();
    const id = createGrant(deps.db, {
      orgId: deps.orgId,
      agentId: agent,
      task,
      match,
      by: session.userId,
      now,
      expiresAt: new Date(now.getTime() + STANDING_DURATIONS[duration]),
    });
    deps.log.warn({ agent, by: session.userId }, "intent grant signed");
    return c.json({ ok: true, next: `/grants?${new URLSearchParams({ granted: id })}` });
  });

  app.post("/grants/revoke", signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const id = (await formField(c, "id")) ?? "";
    if (!visible(session).some((g) => g.id === id && g.state === "live")) {
      return c.text("Refused: no such grant of yours.", 404);
    }
    revokeGrant(deps.db, deps.orgId, id, session.userId, deps.now());
    return c.redirect(`/grants?${new URLSearchParams({ revoked: id })}`, 303);
  });

  return app;
}
