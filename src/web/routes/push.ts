import { readFileSync } from "node:fs";
import { Hono } from "hono";
import { removePushSubscription, savePushSubscription } from "../../store/notifications.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
} from "../http.ts";

/**
 * What makes the approval page an installable web app that can receive
 * notifications (spec: Notifications): the manifest, the service worker,
 * the app icon, and the endpoints a device subscribes and unsubscribes with.
 *
 * - `GET /manifest.webmanifest`, `GET /sw.js`, `GET /icon-180.png`, `GET /icon-512.png`
 * - `POST /push/subscribe` and `POST /push/unsubscribe` (signed in, CSRF)
 */

const MANIFEST = {
  name: "heel",
  short_name: "heel",
  description: "Approve or deny your agents' calls.",
  start_url: "/approvals",
  scope: "/",
  display: "standalone",
  background_color: "#16181D",
  theme_color: "#16181D",
  icons: [
    { src: "/icon-180.png", sizes: "180x180", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
  ],
};

/**
 * Shows each push as a notification, and opens heel's page for it on a tap.
 * It only opens links on heel's own origin, so a push can't send the person
 * anywhere else.
 */
const SERVICE_WORKER = `
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    self.registration.showNotification(data.title || "heel", {
      body: data.body || "A call is waiting for you.",
      data: { url: data.url },
      icon: "/icon-180.png",
      badge: "/icon-180.png",
      tag: data.url,
    }),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  const target = typeof url === "string" && url.startsWith(self.location.origin) ? url : "/approvals";
  event.waitUntil(self.clients.openWindow(target));
});
`;

/** The app icon at a size, read once from assets/logo. */
function icon(size: 180 | 512): Uint8Array<ArrayBuffer> {
  const bytes = readFileSync(
    new URL(`../../../assets/logo/heel-icon-${size}.png`, import.meta.url),
  );
  return new Uint8Array(bytes);
}

/** A push endpoint must be an https URL, and its keys base64url. */
function subscriptionFrom(body: Record<string, unknown> | null) {
  const endpoint = stringField(body, "endpoint");
  const keys = body?.["keys"];
  const keyFields =
    typeof keys === "object" && keys !== null ? (keys as Record<string, unknown>) : null;
  const p256dh = stringField(keyFields, "p256dh");
  const auth = stringField(keyFields, "auth");
  const base64url = /^[A-Za-z0-9_-]+={0,2}$/;
  if (endpoint === undefined || p256dh === undefined || auth === undefined) return null;
  if (!URL.canParse(endpoint) || new URL(endpoint).protocol !== "https:") return null;
  if (!base64url.test(p256dh) || !base64url.test(auth)) return null;
  return { endpoint, p256dh, auth };
}

export function pushRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  const csrf = requireCsrfHeader();
  const icons = { 180: icon(180), 512: icon(512) };

  app.get("/manifest.webmanifest", (c) =>
    c.body(JSON.stringify(MANIFEST), 200, { "content-type": "application/manifest+json" }),
  );
  app.get("/sw.js", (c) =>
    c.body(SERVICE_WORKER, 200, {
      "content-type": "text/javascript; charset=utf-8",
      "cache-control": "no-cache",
    }),
  );
  app.get("/icon-180.png", (c) => c.body(icons[180], 200, { "content-type": "image/png" }));
  app.get("/icon-512.png", (c) => c.body(icons[512], 200, { "content-type": "image/png" }));

  app.post("/push/subscribe", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const subscription = subscriptionFrom(await jsonBody(c));
    if (subscription === null)
      return c.json({ ok: false, message: "That isn't a push subscription." }, 400);
    savePushSubscription(deps.db, {
      orgId: session.orgId,
      userId: session.userId,
      ...subscription,
      now: deps.now(),
    });
    return c.json({ ok: true });
  });

  app.post("/push/unsubscribe", signedIn, csrf, async (c) => {
    const endpoint = stringField(await jsonBody(c), "endpoint") ?? "";
    // Only the person's own devices; someone else's endpoint reads as already gone.
    removePushSubscription(deps.db, endpoint, c.get("session").userId);
    return c.json({ ok: true });
  });

  return app;
}
