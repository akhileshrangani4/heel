import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { isMode, type Mode } from "../../core/modes.ts";
import { modeFor, ORG_DEFAULT, setMode, storedMode } from "../../store/modes.ts";
import { users } from "../../store/schema.ts";
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
import { type ModeRow, type ModesOutcome, modesPage } from "../ui/modes-page.ts";

/**
 * Switching rollout modes, for admins only, on the human plane only.
 *
 * - `GET /modes` lists the org default and each person's mode.
 * - `POST /modes/enforce` tightens a row to enforce: a plain form, like
 *   pausing, because it can only stop calls.
 * - `POST /modes/challenge` then `POST /modes/confirm` loosen a row to
 *   shadow or record with a fresh passkey assertion bound to the row and
 *   mode, like resuming. What changes comes from the signed challenge, never
 *   from the confirming request's body.
 */

function isAdmin(session: SessionView): boolean {
  return session.role === "admin";
}

function label(rows: readonly ModeRow[], ownerId: string): string {
  return rows.find((row) => row.ownerId === ownerId)?.label ?? "Unknown";
}

export function modeRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  const csrf = requireCsrfHeader();

  function rows(): ModeRow[] {
    const people = deps.db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.orgId, deps.orgId))
      .all();
    const fallback: Mode = deps.watchFallback ? "shadow" : "enforce";
    return [
      {
        ownerId: ORG_DEFAULT,
        label: "Everyone (org default)",
        mode: storedMode(deps.db, deps.orgId, ORG_DEFAULT),
        effective: modeFor(deps.db, deps.orgId, ORG_DEFAULT, fallback),
      },
      ...people.map((p) => ({
        ownerId: p.id,
        label: p.name,
        mode: storedMode(deps.db, deps.orgId, p.id),
        effective: modeFor(deps.db, deps.orgId, p.id, fallback),
      })),
    ];
  }

  const known = (ownerId: string) => rows().some((row) => row.ownerId === ownerId);

  function switched(ownerId: string, mode: Mode, by: string): string {
    setMode(deps.db, { orgId: deps.orgId, ownerId, mode, by, at: deps.now() });
    deps.log.warn({ owner: ownerId || "org", mode, by }, "rollout mode switched");
    return `/modes?${new URLSearchParams({ switched: mode, owner: ownerId })}`;
  }

  app.get("/modes", signedIn, (c) => {
    const session = c.get("session");
    if (!isAdmin(session)) return c.text("Only an admin can see and switch modes.", 403);
    const all = rows();
    const query = c.req.query();
    // Only when that row's stored mode is what the link says, so a crafted
    // link can't make the page claim a switch that didn't happen.
    const owner = query["owner"];
    const outcome: ModesOutcome =
      isMode(query["switched"]) &&
      owner !== undefined &&
      all.some((row) => row.ownerId === owner && row.mode === query["switched"])
        ? {
            kind: "switched",
            ownerId: owner,
            label: label(all, owner),
            mode: query["switched"],
          }
        : { kind: "none" };
    return renderPage(c, {
      title: "Modes",
      viewer: viewerOf(session),
      current: "modes",
      body: modesPage({
        rows: all,
        outcome,
        tighten: { action: "/modes/enforce", csrfToken: session.csrfToken },
        watchFallback: deps.watchFallback,
      }),
      script: clientScript(session.csrfToken),
    });
  });

  app.post("/modes/enforce", signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const ownerId = (await formField(c, "owner")) ?? "";
    if (!isAdmin(session) || !known(ownerId)) return c.text("Refused.", 403);
    return c.redirect(switched(ownerId, "enforce", session.userId), 303);
  });

  app.post("/modes/challenge", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const ownerId = stringField(body, "owner") ?? "";
    const mode = stringField(body, "mode");
    if (!isAdmin(session) || !known(ownerId) || !isMode(mode) || mode === "enforce") {
      return c.json({ ok: false, message: "That switch isn't yours to make." }, 403);
    }
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "mode",
      userId: session.userId,
      binding: { owner: ownerId, mode },
      now: deps.now(),
    });
    if (!issued.ok) return c.json({ ok: false, message: "You have no passkey enrolled." }, 400);
    return c.json(issued);
  });

  app.post("/modes/confirm", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "mode",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now: deps.now(),
    });
    if (!verified.ok) return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    // What to switch comes from the signed challenge, never from this body.
    const { owner, mode } = verified.binding;
    if (
      !isAdmin(session) ||
      typeof owner !== "string" ||
      !known(owner) ||
      !isMode(mode) ||
      mode === "enforce"
    ) {
      return c.json({ ok: false, message: "That switch isn't yours to make." }, 409);
    }
    return c.json({ ok: true, next: switched(owner, mode, session.userId) });
  });

  return app;
}
