import { Hono } from "hono";
import { type HumanPlaneDeps, jsonBody, renderPage, stringField } from "../http.ts";
import { findEnrollment, type PasskeyRefusal } from "../passkeys.ts";
import { clientScript } from "../ui/client.ts";
import { enrollPage } from "../ui/enroll.ts";

/**
 * One-time enrollment links (spec: Q-N2). `heel user enroll <user>` on the
 * host prints `/enroll/<token>`; the token is the only thing that lets this
 * page register a passkey, it works once, and it lasts 15 minutes. No
 * session is needed or started: after enrolling, the person signs in.
 *
 * - `GET /enroll/:token` shows the page.
 * - `POST /enroll/:token/options` returns WebAuthn creation options.
 * - `POST /enroll/:token` verifies and stores the new passkey.
 */

const REFUSALS: Partial<Record<PasskeyRefusal, string>> = {
  enrollment_invalid: "This link was already used or has expired.",
  enrollment_waiting: "This recovery link doesn't work yet.",
  already_enrolled: "That passkey is already enrolled.",
  challenge_expired: "The passkey prompt timed out. Try again.",
};

export function enrollRoutes(deps: HumanPlaneDeps): Hono {
  const app = new Hono();

  app.get("/enroll/:token", (c) => {
    const enrollment = findEnrollment(deps.db, c.req.param("token"), deps.now());
    return renderPage(c, {
      title: "Enroll a passkey",
      viewer: null,
      body: enrollPage(
        enrollment === null
          ? { kind: "invalid" }
          : enrollment.waitingUntil !== null
            ? { kind: "waiting", userName: enrollment.userName, until: enrollment.waitingUntil }
            : { kind: "open", token: c.req.param("token"), userName: enrollment.userName },
      ),
      script: clientScript(null),
    });
  });

  app.post("/enroll/:token/options", async (c) => {
    const options = await deps.passkeys.registrationOptions({
      token: c.req.param("token"),
      now: deps.now(),
    });
    if (!options.ok) {
      return c.json({ ok: false, message: REFUSALS[options.reason] ?? "Enrollment failed." }, 400);
    }
    return c.json(options);
  });

  app.post("/enroll/:token", async (c) => {
    const body = await jsonBody(c);
    const finished = await deps.passkeys.finishRegistration({
      token: c.req.param("token"),
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now: deps.now(),
    });
    if (!finished.ok) {
      deps.log.info({ reason: finished.reason }, "passkey enrollment refused");
      return c.json({ ok: false, message: REFUSALS[finished.reason] ?? "Enrollment failed." }, 400);
    }
    deps.log.info({ userId: finished.userId }, "passkey enrolled");
    return c.json({ ok: true, next: "/sign-in?enrolled" });
  });

  return app;
}
