import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import { setUserEmail } from "../../store/notifications.ts";
import { addPerson, listPeople, personNameProblem } from "../../store/people.ts";
import { users } from "../../store/schema.ts";
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
import { createEnrollment, EnrollmentError } from "../passkeys.ts";
import type { SessionView } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { type PeopleLink, peoplePage, personLinkPage } from "../ui/people.ts";

/**
 * People in the web app (roadmap 2.9), as `heel user add`, `heel user enroll`
 * and `heel user email` do on the host. Every change asks for a passkey.
 *
 * - Admins add a person by name (only without a sign-in provider: with one,
 *   people join by signing in) and make passkey links for others. A link for
 *   someone who already has a passkey is a recovery link: it works only after
 *   a day, and their approval page shows it with a way to cancel. An admin's
 *   passkey is never taken as theirs.
 * - Anyone sets where their own notifications go; admins, anyone's.
 *
 * A link is a credential: it's shown once, from memory, on a page no browser
 * keeps, to the admin who made it.
 */

const LINK_VIEW_MS = 10 * 60_000;
const Email = z.email().max(320);

interface PendingLink extends PeopleLink {
  userId: string;
  until: number;
}

export function peopleRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  // In memory only: never stored, logged or put in a URL; a restart drops them.
  const links = new Map<string, PendingLink>();
  const teamSignIn = deps.oidc != null;

  function personById(id: unknown) {
    if (typeof id !== "string") return null;
    return (
      deps.db
        .select({ id: users.id, name: users.name, disabledAt: users.disabledAt })
        .from(users)
        .where(and(eq(users.orgId, deps.orgId), eq(users.id, id)))
        .get() ?? null
    );
  }

  function personNamed(name: string) {
    return (
      deps.db
        .select({ id: users.id, name: users.name, disabledAt: users.disabledAt })
        .from(users)
        .where(and(eq(users.orgId, deps.orgId), eq(users.name, name)))
        .get() ?? null
    );
  }

  /** A link for this person, kept for the admin to see once. */
  function makeLink(session: SessionView, name: string): string {
    const enrollment = createEnrollment(deps.db, {
      orgId: deps.orgId,
      userName: name,
      publicUrl: deps.publicUrl,
      now: deps.now(),
    });
    const now = deps.now().getTime();
    for (const [id, pending] of links) if (pending.until < now) links.delete(id);
    const id = randomBytes(18).toString("base64url");
    links.set(id, {
      userId: session.userId,
      until: now + LINK_VIEW_MS,
      name,
      url: enrollment.url,
      expiresAt: enrollment.expiresAt.toISOString(),
      activeFrom: enrollment.activeFrom?.toISOString() ?? null,
    });
    return id;
  }

  /** What a request asks for, checked before the passkey; the binding it signs. */
  function intentOf(session: SessionView, body: Record<string, unknown> | null) {
    const op = stringField(body, "op") ?? "";
    const admin = session.role === "admin";
    if (op === "add") {
      if (!admin) return { problem: "Only an admin adds people." };
      if (teamSignIn) return { problem: "People join this heel by signing in." };
      const name = (stringField(body, "name") ?? "").trim();
      const problem = personNameProblem(name);
      if (problem !== null) return { problem };
      if (listPeople(deps.db, deps.orgId).some((p) => p.name.toLowerCase() === name)) {
        return { problem: `Someone here is already named ${name}.` };
      }
      return { binding: { op, name } };
    }
    if (op === "link") {
      if (!admin) return { problem: "Only an admin makes passkey links." };
      const person = personNamed(stringField(body, "name") ?? "");
      if (person === null || person.disabledAt !== null) return { problem: "No such person." };
      // Your own other device: "Add another device" on the Approvals page, which works at once.
      if (person.id === session.userId) {
        return { problem: "For a device of your own, use Add another device on Approvals." };
      }
      return { binding: { op, user: person.id } };
    }
    if (op === "email") {
      const person = personNamed(stringField(body, "name") ?? "");
      if (person === null || person.disabledAt !== null) return { problem: "No such person." };
      if (!admin && person.id !== session.userId) {
        return { problem: "You can only change where your own notifications go." };
      }
      const raw = (stringField(body, "email") ?? "").trim();
      if (raw !== "" && !Email.safeParse(raw).success)
        return { problem: "That isn't an email address." };
      return { binding: { op, user: person.id, email: raw } };
    }
    return { problem: "Unknown change." };
  }

  app.get("/people", signedIn, (c) => {
    const session = c.get("session");
    const everyone = listPeople(deps.db, deps.orgId);
    return renderPage(c, {
      title: "People",
      viewer: viewerOf(session),
      current: "people",
      body: peoplePage({
        people:
          session.role === "admin" ? everyone : everyone.filter((p) => p.id === session.userId),
        viewerId: session.userId,
        admin: session.role === "admin",
        teamSignIn,
        saved: "saved" in c.req.query(),
      }),
      script: clientScript(session.csrfToken),
    });
  });

  app.post("/people/challenge", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const intent = intentOf(session, await jsonBody(c));
    if ("problem" in intent) return c.json({ ok: false, message: intent.problem }, 400);
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "people",
      userId: session.userId,
      binding: intent.binding,
      now: deps.now(),
    });
    if (!issued.ok) return c.json({ ok: false, message: "You have no passkey enrolled." }, 400);
    return c.json(issued);
  });

  app.post("/people/confirm", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "people",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now: deps.now(),
    });
    if (!verified.ok) return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    const { op, name, user, email } = verified.binding;
    // Checked again now: a role can change between the prompt and the tap.
    const admin = session.role === "admin";
    const refused = c.json({ ok: false, message: "That change isn't yours to make." }, 409);
    try {
      if (op === "add" && admin && !teamSignIn && typeof name === "string") {
        const added = addPerson(deps.db, deps.orgId, name, deps.now());
        if (!added.ok) return c.json({ ok: false, message: added.problem }, 409);
        deps.log.warn({ person: name, by: session.userId }, "person added from the web app");
        return c.json({ ok: true, next: `/people/link/${makeLink(session, name)}` });
      }
      if (op === "link" && admin) {
        const person = personById(user);
        if (person === null || person.disabledAt !== null || person.id === session.userId) {
          return refused;
        }
        deps.log.warn(
          { person: person.name, by: session.userId },
          "passkey link made from the web app",
        );
        return c.json({ ok: true, next: `/people/link/${makeLink(session, person.name)}` });
      }
      if (op === "email" && typeof email === "string") {
        const person = personById(user);
        if (person === null || (!admin && person.id !== session.userId)) return refused;
        if (!setUserEmail(deps.db, deps.orgId, person.name, email === "" ? null : email)) {
          return refused;
        }
        return c.json({ ok: true, next: "/people?saved" });
      }
    } catch (error) {
      if (error instanceof EnrollmentError)
        return c.json({ ok: false, message: error.message }, 409);
      throw error;
    }
    return refused;
  });

  app.get("/people/link/:id", signedIn, (c) => {
    const session = c.get("session");
    const id = c.req.param("id");
    // The link is in this page: no browser or proxy may keep a copy.
    c.header("Cache-Control", "no-store");
    const pending = links.get(id);
    links.delete(id);
    const fresh =
      pending !== undefined &&
      pending.userId === session.userId &&
      pending.until >= deps.now().getTime();
    return renderPage(c, {
      title: "Passkey link",
      viewer: viewerOf(session),
      current: "people",
      body: personLinkPage(fresh && pending !== undefined ? pending : null),
    });
  });

  return app;
}
