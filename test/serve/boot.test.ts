import { existsSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { adminCall } from "../../src/admin/client.ts";
import { AdminSocketError } from "../../src/admin/server.ts";
import { startupBanner } from "../../src/cli/main.ts";
import { listenerUrl, startHeel } from "../../src/serve.ts";
import { openStore } from "../../src/store/db.ts";
import { MASTER_KEY_ENV } from "../../src/vault/key.ts";
import { captureLogger } from "../helpers/log.ts";
import { addAgentToken, boot, configIn, newKey, silent, urlOf } from "../helpers/serve.ts";
import { tempDir } from "../helpers/store.ts";

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
    expect(ping).toEqual({
      ok: true,
      result: {
        version: "test",
        vault: "unavailable",
        pid: process.pid,
        background: false,
        passkeys: 0,
      },
    });
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

    // A valid token gets past authentication: bare /mcp is code mode, on every host, and a
    // bare GET isn't an MCP request.
    const valid = await fetch(`${agentUrl}/mcp`, bearer(token));
    expect(valid.status).toBe(405);

    const revoke = await adminCall(config.adminSocketPath, {
      method: "agent.revoke",
      params: { name: "inbox-bot" },
    });
    expect(revoke.ok).toBe(true);
    const revoked = await fetch(`${agentUrl}/mcp`, bearer(token));
    expect(revoked.status).toBe(401);
  });

  it("answers an account the agent can't use with 404", async () => {
    // /http is built (D7a): an account the agent can't use reads as unknown.
    const home = tempDir("heel-boot-");
    const config = configIn(home);
    const heel = await boot(config, { [MASTER_KEY_ENV]: newKey() });
    const agentUrl = urlOf(heel.planes.agent);
    const token = await addAgentToken(config, "ci-bot");
    const headers = { authorization: `Bearer ${token}` };

    const noSuchHttpAccount = await fetch(`${agentUrl}/http/github/repos`, {
      method: "POST",
      headers,
    });
    expect(noSuchHttpAccount.status).toBe(404);
    // `/run` is built (D8b): a request with no command line is refused before anything runs.
    const run = await fetch(`${agentUrl}/run`, { method: "POST", headers });
    // 503 where this host can't run the sandbox (every command refused), 400 where it can.
    expect([400, 503]).toContain(run.status);
    const noSuchAccount = await fetch(`${agentUrl}/mcp/gmail-work`, { method: "POST", headers });
    expect(noSuchAccount.status).toBe(404);
    const unknown = await fetch(`${agentUrl}/elsewhere`, { headers });
    expect(unknown.status).toBe(404);
  });

  it("answers approval check-back, read-only, and reads an id it doesn't know as unknown", async () => {
    const home = tempDir("heel-boot-");
    const config = configIn(home);
    const heel = await boot(config, { [MASTER_KEY_ENV]: newKey() });
    const token = await addAgentToken(config, "ci-bot");

    const response = await fetch(`${urlOf(heel.planes.agent)}/approvals/apr_1`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ status: "unknown", approvalId: "apr_1" });
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

describe("what heel says at startup (T8)", () => {
  it("warns when no rules are loaded, since every call is then denied", async () => {
    const { logger, output } = captureLogger();
    await boot(configIn(tempDir("heel-boot-")), { [MASTER_KEY_ENV]: newKey() }, logger);
    expect(output()).toContain('"code":"no_rules"');
    expect(output()).toContain("every call is denied");
  });

  it("prints where to approve and where agents connect", () => {
    const banner = startupBanner(new URL("http://localhost:7301"), {
      agent: { state: "listening", url: "http://127.0.0.1:7300" },
      human: { state: "listening", url: "http://127.0.0.1:7301" },
    });
    expect(banner).toContain("Approve requests:   open http://localhost:7301");
    expect(banner).toContain("Agents connect to:  http://127.0.0.1:7300/mcp");
    const refused = startupBanner(new URL("http://heel.example.com"), {
      agent: { state: "refused", reason: "vault unavailable" },
      human: { state: "refused", reason: "public_url must be https" },
    });
    expect(refused).toContain("Approval page:      off (public_url must be https)");
    expect(refused).toContain("Agent port:         off (vault unavailable)");
  });
});
