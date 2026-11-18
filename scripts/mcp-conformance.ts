/**
 * `pnpm mcp:conformance`: runs the MCP conformance suite against heel's MCP
 * endpoint (spec: D5, "a conformance job", non-blocking at first).
 *
 * It boots a real `heel serve` in a temp home with one passthrough account
 * in front of a small upstream server, then points
 * `@modelcontextprotocol/conformance` at `/mcp/<account>`. The suite can't
 * send headers, so a local proxy adds the agent's heel token to each request.
 *
 * The upstream implements the suite's fixture tools, so the tool scenarios
 * test what heel passes through (text, errors, images, audio, embedded
 * resources), not heel's own deny text. Scenarios for features heel doesn't
 * proxy are listed in `scripts/mcp-conformance-baseline.yml`. The suite fails
 * on any other failure, and on a listed scenario that starts passing.
 * Exits with the suite's own exit code.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

const BASELINE = join(dirname(fileURLToPath(import.meta.url)), "mcp-conformance-baseline.yml");

// A 1x1 PNG and a WAV with no samples: the suite checks type, data and mimeType.
const PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const WAV = (() => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(8000, 24);
  header.writeUInt32LE(8000, 28);
  header.writeUInt16LE(1, 32);
  header.writeUInt16LE(8, 34);
  header.write("data", 36);
  header.writeUInt32LE(0, 40);
  return header.toString("base64");
})();

// The suite's fixture tools, by the names and results its scenarios expect.
const FIXTURES: Record<string, { content: unknown[]; isError?: true }> = {
  test_simple_text: {
    content: [{ type: "text", text: "This is a simple text response for testing." }],
  },
  test_error_handling: {
    content: [{ type: "text", text: "This tool intentionally returns an error for testing" }],
    isError: true,
  },
  test_image_content: { content: [{ type: "image", data: PNG, mimeType: "image/png" }] },
  test_audio_content: { content: [{ type: "audio", data: WAV, mimeType: "audio/wav" }] },
  test_embedded_resource: {
    content: [
      {
        type: "resource",
        resource: {
          uri: "test://embedded-resource",
          mimeType: "text/plain",
          text: "This is an embedded resource content.",
        },
      },
    ],
  },
  test_multiple_content_types: {
    content: [
      { type: "text", text: "Multiple content types test:" },
      { type: "image", data: PNG, mimeType: "image/png" },
      {
        type: "resource",
        resource: {
          uri: "test://mixed-content-resource",
          mimeType: "application/json",
          text: JSON.stringify({ test: "data", value: 123 }),
        },
      },
    ],
  },
};

const upstream = createMcpHandler(() => {
  const server = new Server({ name: "notes", version: "1.0.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler("tools/list", async () => ({
    tools: Object.keys(FIXTURES).map((name) => ({
      name,
      description: `Conformance fixture ${name}.`,
      inputSchema: { type: "object", properties: {} },
    })),
  }));
  server.setRequestHandler("tools/call", async (request) => {
    const fixture = FIXTURES[request.params.name];
    if (fixture === undefined) throw new Error(`unknown tool ${request.params.name}`);
    return fixture as never;
  });
  return server;
});
const upstreamUrl = await listen((request) => upstream.fetch(request));

const home = mkdtempSync(join(tmpdir(), "heel-conformance-"));
mkdirSync(join(home, "rules"));
writeFileSync(
  join(home, "rules", "owner.yaml"),
  `rules:\n${Object.keys(FIXTURES)
    .map((tool) => `  - match: { tool: ${tool} }\n    then: allow\n`)
    .join("")}`,
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
  [
    "-y",
    CONFORMANCE,
    "server",
    "--url",
    `${proxyUrl}/mcp/notes`,
    "--expected-failures",
    BASELINE,
    ...process.argv.slice(2),
  ],
  {
    stdio: "inherit",
  },
);
const code = await new Promise<number>((resolve) =>
  suite.once("exit", (exit) => resolve(exit ?? 1)),
);
await heel.close();
process.exit(code);
