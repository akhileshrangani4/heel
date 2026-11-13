import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { adminCall } from "../../src/admin/client.ts";
import { AdminSocketError } from "../../src/admin/server.ts";
import { type HeelConfig, HeelConfigFileSchema, resolveConfig } from "../../src/config/schema.ts";
import { createLogger, type Logger } from "../../src/log.ts";
import { listenerUrl, type PlaneState, type RunningHeel, startHeel } from "../../src/serve.ts";
import { openStore } from "../../src/store/db.ts";
import { encodeMasterKey, MASTER_KEY_ENV } from "../../src/vault/key.ts";
import { captureLogger } from "../helpers/log.ts";
import { tempDir } from "../helpers/store.ts";

const silent = createLogger("silent");

function newKey(): string {
  return encodeMasterKey(randomBytes(32));
}

/** A config rooted in a temp dir; both planes bind an ephemeral port unless overridden. */
function configIn(home: string, file: Record<string, unknown> = {}): HeelConfig {
  const parsed = HeelConfigFileSchema.parse({
    admin_socket: "run/admin.sock",
    listen: { agent: "127.0.0.1:0", human: "127.0.0.1:0" },
    ...file,
  });
  return resolveConfig(parsed, home, null);
}

async function boot(
  config: HeelConfig,
  env: Record<string, string | undefined>,
  log: Logger = silent,
): Promise<RunningHeel> {
  const heel = await startHeel({ config, env, log, version: "test" });
  onTestFinished(() => heel.close());
  return heel;
}

function urlOf(plane: PlaneState): string {
  if (plane.state !== "listening") throw new Error(`plane refused: ${plane.reason}`);
  return plane.url;
}

/** A port nothing listens on: bound once by the OS, then released. */
async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return address.port;
}

/** Holds a port for the rest of the test. */
async function occupiedPort(): Promise<number> {
  const server: Server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no TCP address");
  return address.port;
}

async function addAgentToken(config: HeelConfig, name: string): Promise<string> {
  const response = await adminCall(config.adminSocketPath, {
    method: "agent.add",
    params: { name },
  });
  if (!response.ok) throw new Error(response.error.message);
  return z.object({ token: z.string() }).parse(response.result).token;
}

describe("listenerUrl", () => {
  it("brackets IPv6 hosts", () => {
    expect(listenerUrl({ address: "127.0.0.1", family: "IPv4", port: 7300 })).toBe(
      "http://127.0.0.1:7300",
    );
    expect(listenerUrl({ address: "::1", family: "IPv6", port: 7300 })).toBe("http://[::1]:7300");
  });
});

describe("heel serve", () => {
  it("vault fails closed: with no master key the agent plane refuses to start", async () => {
    const home = tempDir("heel-boot-");
    const agentPort = await freePort();
    const config = configIn(home, {
      listen: { agent: `127.0.0.1:${agentPort}`, human: "127.0.0.1:0" },
    });
    const { logger, output } = captureLogger();

    const heel = await boot(config, {}, logger);

    expect(heel.planes.agent).toEqual({
      state: "refused",
      reason: expect.stringContaining("vault unavailable"),
    });
    // Nothing listens where the agent plane would have been.
    await expect(fetch(`http://127.0.0.1:${agentPort}/mcp`)).rejects.toThrow();
    // People can still reach heel to fix it.
    expect(heel.planes.human.state).toBe("listening");
    const ping = await adminCall(config.adminSocketPath, { method: "ping" });
    expect(ping).toEqual({ ok: true, result: { version: "test", vault: "unavailable" } });
    expect(output()).toContain("agent plane refused");
  });

  it("vault fails closed: a malformed master key keeps the agent plane down", async () => {
    const home = tempDir("heel-boot-");
    const heel = await boot(configIn(home), { [MASTER_KEY_ENV]: "not-a-key" });
    expect(heel.planes.agent.state).toBe("refused");
  });

  it("vault fails closed: a key other than the one the database was sealed with keeps the agent plane down", async () => {
    const home = tempDir("heel-boot-");
    const config = configIn(home);
    const first = await startHeel({
      config,
      env: { [MASTER_KEY_ENV]: newKey() },
      log: silent,
      version: "test",
    });
    expect(first.planes.agent.state).toBe("listening");
    await first.close();

    const second = await boot(config, { [MASTER_KEY_ENV]: newKey() });
    expect(second.planes.agent).toEqual({
      state: "refused",
      reason: expect.stringContaining("vault unavailable"),
    });
  });

  it("opens the vault from the key file when no key is in the environment", async () => {
    const home = tempDir("heel-boot-");
    writeFileSync(join(home, "master.key"), `${newKey()}\n`, { mode: 0o600 });
    const heel = await boot(configIn(home), {});
    expect(heel.planes.agent.state).toBe("listening");
  });

  it("I-03: the booted agent plane rejects missing, unknown and revoked tokens before any surface runs", async () => {
    const home = tempDir("heel-boot-");
    const config = configIn(home);
    const heel = await boot(config, { [MASTER_KEY_ENV]: newKey() });
    const agentUrl = urlOf(heel.planes.agent);
    const token = await addAgentToken(config, "inbox-bot");
    const bearer = (value: string) => ({ headers: { authorization: `Bearer ${value}` } });

    const missing = await fetch(`${agentUrl}/mcp`, { method: "POST" });
    expect(missing.status).toBe(401);
    // An unauthenticated caller can't tell real endpoints from unknown ones.
    expect((await fetch(`${agentUrl}/no-such-endpoint`)).status).toBe(401);
    const unknown = await fetch(`${agentUrl}/mcp`, bearer(`heel_${"A".repeat(43)}`));
    expect(unknown.status).toBe(401);

    const valid = await fetch(`${agentUrl}/mcp`, bearer(token));
    expect(valid.status).toBe(501);
    expect(await valid.json()).toEqual({
      status: "denied",
      reason: "surface_unavailable",
      rule: null,
    });

    const revoke = await adminCall(config.adminSocketPath, {
      method: "agent.revoke",
      params: { name: "inbox-bot" },
    });
    expect(revoke.ok).toBe(true);
    const revoked = await fetch(`${agentUrl}/mcp`, bearer(token));
    expect(revoked.status).toBe(401);
  });

  it("denies every agent-plane surface until its pipeline exists", async () => {
    const home = tempDir("heel-boot-");
    const config = configIn(home);
    const heel = await boot(config, { [MASTER_KEY_ENV]: newKey() });
    const agentUrl = urlOf(heel.planes.agent);
    const token = await addAgentToken(config, "ci-bot");
    const headers = { authorization: `Bearer ${token}` };

    for (const path of [
      "/mcp",
      "/mcp/gmail-work",
      "/http/github/repos",
      "/run",
      "/approvals/apr_1",
    ]) {
      const response = await fetch(`${agentUrl}${path}`, { method: "POST", headers });
      expect(response.status, path).toBe(501);
    }
    const unknown = await fetch(`${agentUrl}/elsewhere`, { headers });
    expect(unknown.status).toBe(404);
  });

  it("serves the human plane's health check", async () => {
    const home = tempDir("heel-boot-");
    const heel = await boot(configIn(home), { [MASTER_KEY_ENV]: newKey() });
    const response = await fetch(`${urlOf(heel.planes.human)}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("refuses the human plane on a non-https public URL and still starts the agent plane", async () => {
    const home = tempDir("heel-boot-");
    const heel = await boot(configIn(home, { public_url: "http://heel.example.com" }), {
      [MASTER_KEY_ENV]: newKey(),
    });
    expect(heel.planes.human).toEqual({
      state: "refused",
      reason: expect.stringContaining("https://"),
    });
    expect(heel.planes.agent.state).toBe("listening");
  });

  it("a second heel on the same install stops at the admin socket and the first keeps serving", async () => {
    const home = tempDir("heel-boot-");
    const config = configIn(home);
    const env = { [MASTER_KEY_ENV]: newKey() };
    const first = await boot(config, env);

    await expect(startHeel({ config, env, log: silent, version: "test" })).rejects.toBeInstanceOf(
      AdminSocketError,
    );
    const ping = await adminCall(config.adminSocketPath, { method: "ping" });
    expect(ping.ok).toBe(true);
    expect((await fetch(`${urlOf(first.planes.human)}/healthz`)).status).toBe(200);
  });

  it("a port already in use aborts the boot and releases everything it opened", async () => {
    const home = tempDir("heel-boot-");
    const busy = await occupiedPort();
    const config = configIn(home, { listen: { agent: `127.0.0.1:${busy}`, human: "127.0.0.1:0" } });

    await expect(
      startHeel({ config, env: { [MASTER_KEY_ENV]: newKey() }, log: silent, version: "test" }),
    ).rejects.toMatchObject({ code: "EADDRINUSE" });
    expect(existsSync(config.adminSocketPath)).toBe(false);
    // The store was closed: it reopens without a lock or a leaked handle.
    const store = openStore(config.databasePath);
    store.close();
  });

  it("close stops every listener, removes the admin socket and is safe to repeat", async () => {
    const home = tempDir("heel-boot-");
    const config = configIn(home);
    const heel = await startHeel({
      config,
      env: { [MASTER_KEY_ENV]: newKey() },
      log: silent,
      version: "test",
    });
    const agentUrl = urlOf(heel.planes.agent);
    const humanUrl = urlOf(heel.planes.human);
    // A keep-alive connection must not hold close() open.
    expect((await fetch(`${humanUrl}/healthz`)).status).toBe(200);

    await heel.close();
    await heel.close();

    await expect(fetch(`${agentUrl}/mcp`)).rejects.toThrow();
    await expect(fetch(`${humanUrl}/healthz`)).rejects.toThrow();
    expect(existsSync(config.adminSocketPath)).toBe(false);
  });
});
