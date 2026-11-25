import { Hono } from "hono";
import { pushSubscriptionsOf } from "../../store/notifications.ts";
import {
  formField,
  type HumanPlaneDeps,
  passkeyChallenge,
  passkeyFailed,
  renderPage,
  requireCsrfField,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  verifiedBinding,
  viewerOf,
} from "../http.ts";
import { cancelEnrollment, createEnrollment, pendingRecoveries } from "../passkeys.ts";
import { clientScript } from "../ui/client.ts";
import { addDeviceControl } from "../ui/devices.ts";
import { html } from "../ui/html.ts";
import { pushControl } from "../ui/push-control.ts";

/**
 * Passkeys on more devices, from the human plane:
 *
 * - `GET /devices`: Settings, Devices. Notifications on this device, how many
 *   of the person's devices get them, and adding a passkey on another device.
 * - `POST /devices/challenge` then `POST /devices/confirm`: a signed-in person
 *   confirms with a passkey they have and gets a one-time enrollment link that
 *   works at once. This is how to add a phone without waiting a day.
 * - `POST /enroll/recoveries/cancel`: cancels a recovery link made with
 *   `heel user enroll` while it waits. The person it's for, or an admin.
 */
export function deviceRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  app.get("/devices", signedIn, (c) => {
    const session = c.get("session");
    const off = c.req.query("notifications-off") ?? "";
    return renderPage(c, {
      title: "Devices",
      viewer: viewerOf(session),
      current: "devices",
      body: html`<h1>Devices</h1>
        ${pushControl({
          vapidPublicKey: deps.vapidPublicKey,
          devices: {
            count: pushSubscriptionsOf(deps.db, session.userId).length,
            turnOff: { action: "/push/unsubscribe-all", csrfToken: session.csrfToken },
            turnedOff: /^\d+$/.test(off) ? Number(off) : null,
          },
        })}
        ${addDeviceControl()}`,
      script: clientScript(session.csrfToken),
    });
  });

  app.post("/devices/challenge", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    return passkeyChallenge(c, deps, "add_device", { userId: session.userId });
  });

  app.post("/devices/confirm", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const now = deps.now();
    const binding = await verifiedBinding(c, deps, "add_device", now);
    if (binding === null || binding["userId"] !== session.userId) return passkeyFailed(c);
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
