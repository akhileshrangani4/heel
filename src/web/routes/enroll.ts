import { Hono } from "hono";
import { pushSubscriptionsOf } from "../../store/notifications.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  renderPage,
  requireSession,
  type SignedInEnv,
  setSessionCookie,
  stringField,
  viewerOf,
} from "../http.ts";
import { findEnrollment, type PasskeyRefusal } from "../passkeys.ts";
import { startSession } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { enrollPage } from "../ui/enroll.ts";
import { welcomePage } from "../ui/welcome.ts";

/**
 * One-time enrollment links (spec: Q-N2). `heel user enroll <user>` on the
 * host prints `/enroll/<token>`; the token is the only thing that lets this
 * page register a passkey, it works once, and it lasts 15 minutes. No
 * session is needed. Making the passkey proves the person holds it, so heel
 * signs them in and shows the welcome page, where they turn on notifications
 * for this device (roadmap 2.7). With team sign-in (OIDC) they sign in there.
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
    return renderPage(
      c,
      {
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
      },
      // Unknown, used or expired all answer the same 404: no hint a link ever existed.
      enrollment === null ? 404 : 200,
    );
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
    if (deps.oidc != null) return c.json({ ok: true, next: "/sign-in?enrolled" });
    const started = startSession(deps.db, {
      orgId: deps.orgId,
      userId: finished.userId,
      method: "passkey",
      now: deps.now(),
    });
    setSessionCookie(c, deps, started);
    return c.json({ ok: true, next: "/welcome" });
  });

  // Right after enrolling (2.7): turn on notifications for this device, then go to Approvals.
  const signedIn = new Hono<SignedInEnv>();
  signedIn.get("/welcome", requireSession(deps), (c) => {
    const session = c.get("session");
    return renderPage(c, {
      title: "Welcome",
      viewer: viewerOf(session),
      current: "home",
      body: welcomePage({
        vapidPublicKey: deps.vapidPublicKey,
        devices: pushSubscriptionsOf(deps.db, session.userId).length,
      }),
      script: clientScript(session.csrfToken),
    });
  });
  app.route("/", signedIn);

  return app;
}
