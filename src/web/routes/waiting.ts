import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  type HumanPlaneDeps,
  readSessionCookie,
  requireSession,
  type SignedInEnv,
} from "../http.ts";
import { readSession } from "../sessions.ts";
import { waitingVersion } from "../waiting.ts";

/**
 * `GET /waiting/stream`: tells an open page that what waits for its owner
 * changed, as server-sent events. One mechanism drives the menu badge, the
 * tab title, the favicon dot, the banner, and the refresh of Home, Approvals
 * and the request pages.
 *
 * Each event is `{"waiting": <count>, "version": <opaque hash>}` and nothing
 * else: no names, ids, arguments or credentials, so it is as safe as the
 * title bar. It needs the owner's session, like the Activity stream beside
 * it; it changes nothing, and an EventSource can't send the CSRF header, so
 * like that stream it relies on the session cookie (SameSite=Lax, so another
 * site's page can't open it with the cookie) and on browsers refusing to let
 * another origin read the response.
 *
 * The first event goes out at once, so a page that reconnects after sleeping
 * catches up straight away. Then the stream checks every couple of seconds
 * and sends only on a change, plus a comment line now and then so proxies
 * keep it open. It ends after a while; the browser reconnects on its own.
 */

const CHECK_MS = 2_000;
const KEEPALIVE_MS = 25_000;
const LIFETIME_MS = 10 * 60_000;

export function waitingRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  app.get("/waiting/stream", signedIn, (c) => {
    const session = c.get("session");
    const cookie = readSessionCookie(c, deps);
    c.header("Cache-Control", "no-store");
    return streamSSE(c, async (stream) => {
      const ends = Date.now() + LIFETIME_MS;
      let sent = "";
      let quietSince = Date.now();
      while (!stream.aborted && Date.now() < ends) {
        const now = deps.now();
        // Signed out, or the session ran out, since the stream opened: stop (fail closed).
        if (cookie === undefined || readSession(deps.db, cookie, now) === null) break;
        const state = waitingVersion(deps, session, now);
        const data = JSON.stringify(state);
        if (data !== sent) {
          await stream.writeSSE({ event: "waiting", data });
          sent = data;
          quietSince = Date.now();
        } else if (Date.now() - quietSince >= KEEPALIVE_MS) {
          await stream.write(": still here\n\n");
          quietSince = Date.now();
        }
        await stream.sleep(CHECK_MS);
      }
    });
  });

  return app;
}
