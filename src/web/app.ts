import { Hono } from "hono";
import type { Logger } from "../log.ts";

export interface HumanAppDeps {
  log: Logger;
}

/**
 * The human plane: passkey sign-in, the approval page and pause controls
 * arrive with D4. In this build it serves only a health check, so an
 * operator can confirm the listener and its proxy before anything decides.
 */
export function createHumanApp(deps: HumanAppDeps): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => c.json({ status: "ok" }));
  app.notFound((c) => c.json({ error: "not_found" }, 404));
  app.onError((error, c) => {
    deps.log.error({ err: error, path: c.req.path }, "human plane request failed");
    return c.json({ error: "internal" }, 500);
  });
  return app;
}
