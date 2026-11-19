import { Hono } from "hono";
import { type HumanPlaneDeps, requireSameOrigin } from "./http.ts";
import { activityRoutes } from "./routes/activity.ts";
import { approvalRoutes } from "./routes/approvals.ts";
import { connectionRoutes } from "./routes/connections.ts";
import { deviceRoutes } from "./routes/devices.ts";
import { enrollRoutes } from "./routes/enroll.ts";
import { grantRoutes } from "./routes/grants.ts";
import { modeRoutes } from "./routes/modes.ts";
import { oauthRoutes } from "./routes/oauth.ts";
import { oidcRoutes } from "./routes/oidc.ts";
import { pauseRoutes } from "./routes/pause.ts";
import { proposalRoutes } from "./routes/proposals.ts";
import { pushRoutes } from "./routes/push.ts";
import { signInRoutes } from "./routes/sign-in.ts";
import { standingRoutes } from "./routes/standing.ts";

export type { HumanPlaneDeps } from "./http.ts";

/**
 * The human plane (spec: Listeners): where people sign in with a passkey,
 * read and decide approval requests, pause and resume, and revoke standing
 * approvals. Agent tokens are never accepted here (I-58): every route uses
 * a passkey session, a one-time enrollment link, or nothing at all.
 *
 * Each area lives in its own file under routes/, and the shared checks
 * (sessions, origin, CSRF) live in http.ts.
 */
export function createHumanApp(deps: HumanPlaneDeps): Hono {
  const app = new Hono();
  // On every response (red-team round 3): no page can be framed by another
  // site (clickjacking a passkey button), no <base> or plugin injection, no
  // content sniffing, and approval ids in URLs don't leak through Referer.
  app.use("*", async (c, next) => {
    await next();
    c.header("X-Frame-Options", "DENY");
    c.header(
      "Content-Security-Policy",
      "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
    );
    c.header("X-Content-Type-Options", "nosniff");
    // same-origin, not no-referrer: with no-referrer browsers send `Origin: null` on form posts,
    // which requireSameOrigin refuses. Nothing goes to other sites either way.
    c.header("Referrer-Policy", "same-origin");
  });
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  // Before any route: a state-changing request from another origin never reaches one.
  app.use("*", requireSameOrigin(deps));
  app.get("/", (c) => c.redirect("/approvals", 303));
  app.route("/", signInRoutes(deps));
  app.route("/", oidcRoutes(deps));
  app.route("/", enrollRoutes(deps));
  app.route("/", deviceRoutes(deps));
  app.route("/", approvalRoutes(deps));
  app.route("/", proposalRoutes(deps));
  app.route("/", pauseRoutes(deps));
  app.route("/", standingRoutes(deps));
  app.route("/", pushRoutes(deps));
  app.route("/", oauthRoutes(deps));
  app.route("/", connectionRoutes(deps));
  app.route("/", modeRoutes(deps));
  app.route("/", grantRoutes(deps));
  app.route("/", activityRoutes(deps));
  app.notFound((c) => c.text("Not found.", 404));
  app.onError((error, c) => {
    deps.log.error({ err: error, path: c.req.path }, "human plane request failed");
    return c.text("Something went wrong in heel. Nothing was decided.", 500);
  });
  return app;
}
