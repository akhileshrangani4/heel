import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import {
  AgentError,
  addAgent,
  checkedWorkRoots,
  isValidAgentName,
  revokeAgent,
  rotateAgentToken,
  setWorkRoots,
  workRootsByName,
} from "../../gateway/agents.ts";
import { agents } from "../../store/schema.ts";
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
import { newTokenPage } from "../ui/manage-agents.ts";

/**
 * Agents from the web app, as `heel agent` does them on the
 * host. What gives power asks for a passkey: adding an agent, a new token,
 * a new workdir. What only takes power away is a plain form: revoking an
 * agent, removing a workdir. Members manage their own agents; admins anyone's.
 *
 * - `POST /agents/manage/challenge` then `POST /agents/manage/confirm`: add,
 *   new token, or add a workdir. What happens comes from the signed challenge.
 * - `GET /agents/token/:id`: a new token, shown once to whoever made it.
 * - `POST /agents/:name/revoke`, `POST /agents/:name/workdirs/remove`.
 */

/** How long a new token waits to be seen. It's shown once, then gone. */
const TOKEN_VIEW_MS = 5 * 60 * 1000;
const TOKEN_DAYS = new Set(["30", "90", "365", "never"]);

interface PendingToken {
  userId: string;
  name: string;
  token: string;
  expiresAt: string | null;
  until: number;
}

export function manageAgentRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  // In memory only: a token is never stored or put in a URL, and a restart drops it.
  const tokens = new Map<string, PendingToken>();
  const protectedPaths = () => (deps.ruleFiles === undefined ? [] : [deps.ruleFiles.paths.home]);

  /**
   * The live agent by name that this person may manage, or null. Admins may
   * revoke anyone's agent or remove a workdir, but a new token or workdir
   * only for their own (`own`): a new token would hand them a working
   * credential for another person's agent, quietly ending that person's.
   */
  function mine(session: SessionView, name: string, own = false) {
    const row = deps.db
      .select({ id: agents.id, ownerId: agents.ownerId, revokedAt: agents.revokedAt })
      .from(agents)
      .where(and(eq(agents.orgId, deps.orgId), eq(agents.name, name)))
      .get();
    if (row === undefined || row.revokedAt !== null) return null;
    return row.ownerId === session.userId || (!own && session.role === "admin") ? row : null;
  }

  function stopScriptsOf(agentId: string): void {
    for (const script of deps.background?.list(null) ?? []) {
      if (script.agentId === agentId) deps.background?.stop(script.id);
    }
  }

  function keep(
    session: SessionView,
    issued: { name: string; token: string; expiresAt: string | null },
  ) {
    const now = deps.now().getTime();
    for (const [id, pending] of tokens) if (pending.until < now) tokens.delete(id);
    const id = randomBytes(18).toString("base64url");
    tokens.set(id, { userId: session.userId, ...issued, until: now + TOKEN_VIEW_MS });
    return id;
  }

  /** What a request asks for, checked; the binding the passkey signs. */
  function intentOf(session: SessionView, body: Record<string, unknown> | null) {
    const op = stringField(body, "op") ?? "";
    const name = (stringField(body, "name") ?? "").trim();
    if (op === "add") {
      // Checked before the passkey, so a bad name doesn't use up a tap.
      if (!isValidAgentName(name)) {
        return {
          problem:
            "An agent's name is 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit.",
        };
      }
      const taken = deps.db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.orgId, deps.orgId), eq(agents.name, name)))
        .get();
      if (taken !== undefined)
        return { problem: `An agent named ${name} already exists (or did).` };
      const days = stringField(body, "days") ?? "90";
      if (!TOKEN_DAYS.has(days)) return { problem: "Pick how long the token lasts." };
      return { binding: { op, name, days } };
    }
    if (mine(session, name, true) === null)
      return { problem: "There's no live agent of yours by that name." };
    if (op === "rotate") {
      const days = stringField(body, "days") ?? "90";
      if (!TOKEN_DAYS.has(days)) return { problem: "Pick how long the token lasts." };
      return { binding: { op, name, days } };
    }
    if (op === "workdir") {
      const path = (stringField(body, "path") ?? "").trim();
      try {
        // As it would be stored, symlinks followed: that's what's signed and shown.
        const roots = checkedWorkRoots(
          deps.db,
          deps.orgId,
          name,
          [...workRootsByName(deps.db, deps.orgId, name).workRoots, path],
          protectedPaths(),
        ).workRoots;
        return { binding: { op, name, path: roots.at(-1) ?? path } };
      } catch (error) {
        if (error instanceof AgentError) return { problem: error.message };
        throw error;
      }
    }
    return { problem: "Unknown change." };
  }

  app.post("/agents/manage/challenge", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const intent = intentOf(session, await jsonBody(c));
    if ("problem" in intent) return c.json({ ok: false, message: intent.problem }, 400);
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "manage",
      userId: session.userId,
      binding: intent.binding,
      now: deps.now(),
    });
    if (!issued.ok) return c.json({ ok: false, message: "You have no passkey enrolled." }, 400);
    return c.json(issued);
  });

  app.post("/agents/manage/confirm", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "manage",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now: deps.now(),
    });
    if (!verified.ok) return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    // What to do comes from the signed challenge, never from this body.
    const { op, name, days, path } = verified.binding;
    const now = deps.now();
    const expires = days === "never" ? null : Number(days);
    try {
      if (op === "add" && typeof name === "string") {
        const issued = addAgent(
          deps.db,
          { orgId: deps.orgId, ownerId: session.userId, name, expiresInDays: expires },
          now,
        );
        deps.log.info({ agent: name, by: session.userId }, "agent added from the web app");
        return c.json({ ok: true, next: `/agents/token/${keep(session, issued)}` });
      }
      const agent = typeof name === "string" ? mine(session, name, true) : null;
      if (op === "rotate" && typeof name === "string" && agent !== null) {
        const issued = rotateAgentToken(deps.db, deps.orgId, name, now, expires);
        // Scripts started with the old token stop now, as `heel agent rotate` does.
        stopScriptsOf(agent.id);
        deps.log.info({ agent: name, by: session.userId }, "agent token replaced from the web app");
        return c.json({ ok: true, next: `/agents/token/${keep(session, issued)}` });
      }
      if (
        op === "workdir" &&
        typeof name === "string" &&
        typeof path === "string" &&
        agent !== null
      ) {
        // Checked again as it would be stored now: a symlink swapped in after the passkey
        // was asked for would point somewhere else than what was signed.
        const roots = checkedWorkRoots(
          deps.db,
          deps.orgId,
          name,
          [...workRootsByName(deps.db, deps.orgId, name).workRoots, path],
          protectedPaths(),
        ).workRoots;
        if (roots.at(-1) !== path) {
          return c.json(
            { ok: false, message: "That folder changed since you approved it. Nothing was added." },
            409,
          );
        }
        setWorkRoots(deps.db, deps.orgId, name, roots, protectedPaths());
        deps.log.info({ agent: name, by: session.userId }, "workdir added from the web app");
        return c.json({ ok: true, next: "/agents?workdir-added" });
      }
    } catch (error) {
      if (error instanceof AgentError) return c.json({ ok: false, message: error.message }, 409);
      throw error;
    }
    return c.json({ ok: false, message: "That change isn't yours to make." }, 409);
  });

  app.get("/agents/token/:id", signedIn, (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    // The token is in this page: no browser or proxy may keep a copy.
    c.header("Cache-Control", "no-store");
    const pending = tokens.get(id);
    // Once, to whoever made it, while it's fresh.
    tokens.delete(id);
    const fresh =
      pending !== undefined &&
      pending.userId === session.userId &&
      pending.until >= deps.now().getTime();
    return renderPage(c, {
      title: "New agent token",
      viewer: viewerOf(session),
      current: "agents",
      body: newTokenPage(
        fresh && pending !== undefined
          ? {
              name: pending.name,
              token: pending.token,
              expiresAt: pending.expiresAt,
              mcpUrl: deps.agentMcpUrl ?? null,
            }
          : null,
      ),
    });
  });

  // Only takes power away: a plain form, no passkey (like pausing).
  app.post("/agents/:name/revoke", signedIn, requireCsrfField(), (c) => {
    const session = c.get("session");
    const name = c.req.param("name");
    const agent = mine(session, name);
    if (agent === null) return c.text("There's no live agent of yours by that name.", 404);
    revokeAgent(deps.db, deps.orgId, name, deps.now());
    // Its background scripts stop too, as `heel agent revoke` does.
    stopScriptsOf(agent.id);
    deps.log.info({ agent: name, by: session.userId }, "agent revoked from the web app");
    return c.redirect("/agents?revoked", 303);
  });

  app.post("/agents/:name/workdirs/remove", signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const name = c.req.param("name");
    if (mine(session, name) === null)
      return c.text("There's no live agent of yours by that name.", 404);
    const path = (await formField(c, "path")) ?? "";
    const agent = mine(session, name);
    const left = workRootsByName(deps.db, deps.orgId, name).workRoots.filter(
      (root) => root !== path,
    );
    // Removing only takes power away, so the rest aren't checked again: a folder that's
    // since been deleted mustn't stop the owner removing another.
    if (agent !== null)
      deps.db.update(agents).set({ workRoots: left }).where(eq(agents.id, agent.id)).run();
    return c.redirect("/agents?workdir-removed", 303);
  });

  return app;
}
