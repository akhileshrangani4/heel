import { serve } from "@hono/node-server";
import { createPreviewApp } from "../src/web/ui/preview/app.ts";

/**
 * `pnpm ui:preview [port]`: serves the UI preview harness on loopback only.
 * Fixture props, no store, no sessions; never part of `heel serve`.
 */
const port = Number(process.argv[2] ?? process.env["HEEL_PREVIEW_PORT"] ?? 7399);
if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  console.error(`ui-preview: invalid port ${String(process.argv[2])}`);
  process.exit(64);
}

serve({ fetch: createPreviewApp().fetch, port, hostname: "127.0.0.1" }, (info) => {
  process.stdout.write(`heel UI preview on http://127.0.0.1:${info.port}/\n`);
});
