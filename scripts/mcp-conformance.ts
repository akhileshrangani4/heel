/**
 * `pnpm mcp:conformance`: runs the MCP conformance suite against heel's MCP
 * endpoint (spec: D5, "a conformance job", non-blocking at first).
 *
 * It boots a real `heel serve` in a temp home with one passthrough account
 * in front of a small upstream server, then points
 * `@modelcontextprotocol/conformance` at `/mcp/<account>`. The suite can't
 * send headers, so a local proxy adds the agent's heel token to each request.
 * Exits with the suite's own exit code.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";
import { adminCall } from "../src/admin/client.ts";
import { HeelConfigFileSchema, resolveConfig } from "../src/config/schema.ts";
import { createLogger } from "../src/log.ts";
import { startHeel } from "../src/serve.ts";
import { encodeMasterKey, MASTER_KEY_ENV } from "../src/vault/key.ts";

const CONFORMANCE = "@modelcontextprotocol/conformance@0.1.16";

async function listen(fetch: (request: Request) => Promise<Response>): Promise<string> {
  const server = createServer(getRequestListener(fetch));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

// An upstream with one tool, so heel has something to serve.
const upstream = createMcpHandler(() => {
  const server = new Server({ name: "notes", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({
    tools: [
      {
        name: "echo",
        description: "Echo the text back.",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      },
    ],
  }));
  server.setRequestHandler("tools/call", async (request) => ({
    content: [{ type: "text", text: String(request.params.arguments?.["text"] ?? "") }],
  }));
  return server;
});
const upstreamUrl = await listen((request) => upstream.fetch(request));

const home = mkdtempSync(join(tmpdir(), "heel-conformance-"));
mkdirSync(join(home, "rules"));
writeFileSync(
  join(home, "rules", "owner.yaml"),
  "rules:\n  - match: { tool: echo }\n    then: allow\n",
);
const config = resolveConfig(
  HeelConfigFileSchema.parse({
    admin_socket: "run/admin.sock",
    listen: { agent: "127.0.0.1:0", human: "127.0.0.1:0" },
  }),
  home,
  null,
);
const heel = await startHeel({
  config,
  env: { [MASTER_KEY_ENV]: encodeMasterKey(randomBytes(32)) },
  log: createLogger("warn"),
  version: "conformance",
});
if (heel.planes.agent.state !== "listening") throw new Error("the agent plane didn't start");
const agentUrl = heel.planes.agent.url;

const added = await adminCall(config.adminSocketPath, {
  method: "agent.add",
  params: { name: "conformance" },
});
if (!added.ok) throw new Error(added.error.message);
const { token } = added.result as { token: string };
const connected = await adminCall(config.adminSocketPath, {
  method: "account.connect",
  params: { provider: "mcp", alias: "notes", url: `${upstreamUrl}/mcp` },
});
if (!connected.ok) throw new Error(connected.error.message);

// The suite can't send headers: add the agent's token on the way through.
const proxyUrl = await listen(async (request) => {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.set("authorization", `Bearer ${token}`);
  return fetch(new URL(url.pathname + url.search, agentUrl), {
    method: request.method,
    headers,
    ...(request.body === null ? {} : { body: request.body, duplex: "half" }),
  } as RequestInit);
});

const suite = spawn(
  "npx",
  ["-y", CONFORMANCE, "server", "--url", `${proxyUrl}/mcp/notes`, ...process.argv.slice(2)],
  {
    stdio: "inherit",
  },
);
const code = await new Promise<number>((resolve) =>
  suite.once("exit", (exit) => resolve(exit ?? 1)),
);
await heel.close();
process.exit(code);
