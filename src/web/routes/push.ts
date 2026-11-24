import { readFileSync } from "node:fs";
import { Hono } from "hono";
import {
  removeAllPushSubscriptions,
  removePushSubscription,
  savePushSubscription,
} from "../../store/notifications.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  requireCsrfField,
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
 *
 * A push also tells heel's open pages to check what's waiting now (the
 * message says only "changed"; each page asks the server itself). A tap
 * reuses an open heel window, focused and sent to the page, and opens a new
 * one only when there is none, so stale copies don't pile up.
 */
const SERVICE_WORKER = `
const windows = () => self.clients.matchAll({ type: "window", includeUncontrolled: true });
self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || "heel", {
        body: data.body || "A call is waiting for you.",
        data: { url: data.url },
        icon: "/icon-180.png",
        badge: "/icon-180.png",
        tag: data.url,
      }),
      windows().then((list) => list.forEach((c) => c.postMessage({ type: "heel-changed" }))),
    ]),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data && event.notification.data.url;
  const target = typeof url === "string" && url.startsWith(self.location.origin) ? url : "/approvals";
  event.waitUntil(
    windows().then(async (list) => {
      const open = list.find((c) => c.url.startsWith(self.location.origin));
      if (!open) return self.clients.openWindow(target);
      const focused = await open.focus().catch(() => open);
      if ("navigate" in focused) {
        try {
          if (await focused.navigate(target)) return;
        } catch {}
      }
      // Not controlled by this worker yet: the page goes there itself.
      focused.postMessage({ type: "heel-navigate", url: target });
    }),
  );
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
/**
 * The browsers' own push services. heel POSTs to a subscription's endpoint
 * for every request, so any other host would let whoever subscribes point
 * heel at their own server, or at one inside your network.
 */
const PUSH_SERVICE_HOSTS = [
  "fcm.googleapis.com", // Chrome, Edge on Android, most Chromium browsers
  "android.googleapis.com",
  "updates.push.services.mozilla.com", // Firefox
  ".push.services.mozilla.com",
  "web.push.apple.com", // Safari, and web apps on iPhone and iPad
  ".push.apple.com",
  ".notify.windows.com", // Edge on Windows
] as const;

export function isPushService(url: URL): boolean {
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return PUSH_SERVICE_HOSTS.some((allowed) =>
    allowed.startsWith(".")
      ? host.endsWith(allowed) && host.length > allowed.length
      : host === allowed,
  );
}

function subscriptionFrom(body: Record<string, unknown> | null) {
  const endpoint = stringField(body, "endpoint");
  const keys = body?.["keys"];
  const keyFields =
    typeof keys === "object" && keys !== null ? (keys as Record<string, unknown>) : null;
  const p256dh = stringField(keyFields, "p256dh");
  const auth = stringField(keyFields, "auth");
  const base64url = /^[A-Za-z0-9_-]+={0,2}$/;
  if (endpoint === undefined || p256dh === undefined || auth === undefined) return null;
  if (!URL.canParse(endpoint) || !isPushService(new URL(endpoint))) return null;
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
    const saved = savePushSubscription(deps.db, {
      orgId: session.orgId,
      userId: session.userId,
      ...subscription,
      now: deps.now(),
    });
    if (!saved) return c.json({ ok: false, message: "That isn't a push subscription." }, 400);
    return c.json({ ok: true });
  });

  app.post("/push/unsubscribe", signedIn, csrf, async (c) => {
    const endpoint = stringField(await jsonBody(c), "endpoint") ?? "";
    // Only the person's own devices; someone else's endpoint reads as already gone.
    removePushSubscription(deps.db, endpoint, c.get("session").userId);
    return c.json({ ok: true });
  });

  app.post("/push/unsubscribe-all", signedIn, requireCsrfField(), (c) => {
    const removed = removeAllPushSubscriptions(deps.db, c.get("session").userId);
    return c.redirect(`/devices?notifications-off=${removed}`, 303);
  });

  return app;
}
