import { Hono } from "hono";
import { type HumanPlaneDeps, requireSameOrigin } from "./http.ts";
import { approvalRoutes } from "./routes/approvals.ts";
import { enrollRoutes } from "./routes/enroll.ts";
import { oauthRoutes } from "./routes/oauth.ts";
import { pauseRoutes } from "./routes/pause.ts";
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
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  // Before any route: a state-changing request from another origin never reaches one.
  app.use("*", requireSameOrigin(deps));
  app.get("/", (c) => c.redirect("/approvals", 303));
  app.route("/", signInRoutes(deps));
  app.route("/", enrollRoutes(deps));
  app.route("/", approvalRoutes(deps));
  app.route("/", pauseRoutes(deps));
  app.route("/", standingRoutes(deps));
  app.route("/", pushRoutes(deps));
  app.route("/", oauthRoutes(deps));
  app.notFound((c) => c.text("Not found.", 404));
  app.onError((error, c) => {
    deps.log.error({ err: error, path: c.req.path }, "human plane request failed");
    return c.text("Something went wrong in heel. Nothing was decided.", 500);
  });
  return app;
}
