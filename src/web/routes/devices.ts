import { Hono } from "hono";
import {
  formField,
  type HumanPlaneDeps,
  jsonBody,
  requireCsrfField,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
} from "../http.ts";
import { cancelEnrollment, createEnrollment, pendingRecoveries } from "../passkeys.ts";

/**
 * Passkeys on more devices (spec: Q-N2), from the human plane:
 *
 * - `POST /devices/challenge` then `POST /devices/confirm`: a signed-in person
 *   confirms with a passkey they have and gets a one-time enrollment link that
 *   works at once. This is how to add a phone without waiting a day.
 * - `POST /enroll/recoveries/cancel`: cancels a recovery link made with
 *   `heel user enroll` while it waits. The person it's for, or an admin.
 */
export function deviceRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  app.post("/devices/challenge", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "add_device",
      userId: session.userId,
      binding: { userId: session.userId },
      now: deps.now(),
    });
    if (!issued.ok) return c.json({ ok: false, message: "You have no passkey enrolled." }, 400);
    return c.json(issued);
  });

  app.post("/devices/confirm", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const now = deps.now();
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "add_device",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now,
    });
    if (!verified.ok || verified.binding["userId"] !== session.userId) {
      return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    }
    const link = createEnrollment(deps.db, {
      orgId: deps.orgId,
      userName: session.userName,
      publicUrl: deps.publicUrl,
      now,
      afterPasskey: true,
    });
    deps.log.info({ userId: session.userId }, "device enrollment link made with a passkey");
    return c.json({
      ok: true,
      link: link.url,
      message: `Open this link on your other device within 15 minutes: ${link.url}`,
    });
  });

  app.post("/enroll/recoveries/cancel", signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const id = (await formField(c, "id")) ?? "";
    const recovery = pendingRecoveries(deps.db, deps.orgId, deps.now()).find((r) => r.id === id);
    if (
      recovery === undefined ||
      (recovery.userId !== session.userId && session.role !== "admin")
    ) {
      return c.text("There's no such recovery link for you to cancel.", 404);
    }
    cancelEnrollment(deps.db, deps.orgId, id);
    deps.log.warn({ by: session.userId, for: recovery.userId }, "recovery link cancelled");
    return c.redirect("/approvals", 303);
  });

  return app;
}
