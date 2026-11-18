import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { mcpPassthrough } from "../../src/definitions/mcp/passthrough.ts";
import type { StdioProcess } from "../../src/definitions/mcp/sandbox-transport.ts";
import { stdioSandboxSpec, upstreamSettings } from "../../src/definitions/mcp/settings.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { MAX_WALL_TIME_MS } from "../../src/runner/plan.ts";
import { findAccount } from "../../src/store/directory.ts";
import { ConnectError, connectAccount } from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "../helpers/log.ts";
import { testStore } from "../helpers/store.ts";

/**
 * Local (stdio) MCP servers (D5b). Here the fixture server runs as a plain
 * child process, so the transport, pool and passthrough are tested on every
 * OS; e2e/runner/mcp-stdio.test.ts runs the same server under bubblewrap.
 */

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp/stdio-server.ts", import.meta.url));
const TOKEN = "local-test-token";

const STDIO = {
  command: process.execPath,
  args: [FIXTURE],
  egress: [],
  credentialEnv: "NOTES_TOKEN",
  mounts: [FIXTURE],
};

/** Starts the fixture the way the sandbox would, with the credential in its environment. */
async function launchChild(
  _account: unknown,
  _settings: unknown,
  credential: string | null,
): Promise<StdioProcess> {
  const child = spawn(process.execPath, [FIXTURE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env["PATH"] ?? "",
      ...(credential === null ? {} : { NOTES_TOKEN: credential }),
    },
  });
  const done = new Promise((resolve) => child.once("exit", resolve));
  onTestFinished(() => {
    child.kill();
  });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    stderr: child.stderr,
    done,
    kill: () => child.kill(),
  };
}

function setUp(options: { launch?: boolean } = {}) {
  const t = testStore();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  connectAccount(
    t.db,
    vault,
    {
      orgId: t.orgId,
      ownerId: t.ownerId,
      provider: "mcp",
      alias: "local-notes",
      stdio: STDIO,
      credential: { type: "static", value: TOKEN },
    },
    new Date(),
  );
  const pool = new UpstreamPool({
    vault,
    log: captureLogger().logger,
    ...(options.launch !== false && { launchStdio: launchChild }),
  });
  onTestFinished(() => pool.close());
  const account = findAccount(t.db, t.orgId, "local-notes");
  if (account === null) throw new Error("no account");
  return { t, pool, account };
}

describe("local MCP servers", () => {
  it("stores how to start the server, never the credential", () => {
    const { account } = setUp();
    expect(account.provider).toBe("mcp:local-notes");
    expect(upstreamSettings(account.settings)).toEqual({ transport: "stdio", ...STDIO });
    expect(JSON.stringify(account.settings)).not.toContain(TOKEN);
  });

  it("lists and calls the server's tools over stdio", async () => {
    const { pool, account } = setUp();
    const definition = mcpPassthrough(account, pool);
    const signal = AbortSignal.timeout(10_000);

    expect((await pool.listTools(account, signal)).map((tool) => tool.name)).toEqual([
      "echo",
      "token",
    ]);
    const result = await definition.execute(
      { ...callFor(account), tool: "echo", args: { text: "hi" } },
      signal,
    );
    expect(result).toMatchObject({ content: [{ type: "text", text: "hi" }] });
  });

  it("I-02: gives the server its credential in one variable, and scrubs it from results", async () => {
    const { pool, account } = setUp();
    const result = await mcpPassthrough(account, pool).execute(
      { ...callFor(account), tool: "token", args: {} },
      AbortSignal.timeout(10_000),
    );
    expect(result).toMatchObject({ content: [{ text: "token: [redacted by heel]" }] });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("denies calls when the host can't run the sandbox", async () => {
    const { pool, account } = setUp({ launch: false });
    const normalized = await mcpPassthrough(account, pool).normalize(
      { ...callFor(account), tool: "echo", args: {} },
      { signal: AbortSignal.timeout(10_000), hide: [] },
    );
    expect(normalized).toEqual({ ok: false, reason: "lookup_unavailable" });
  });

  it.each([
    ["a relative command", { ...STDIO, command: "node" }, /absolute/],
    ["a relative mount", { ...STDIO, mounts: ["fixtures"] }, /absolute/],
    ["a bad egress entry", { ...STDIO, egress: ["not a host"] }, /.+/],
    ["a credential with no variable for it", { ...STDIO, credentialEnv: null }, /credential-env/],
  ])("refuses %s", (_label, stdio, message) => {
    const t = testStore();
    const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
    const connect = () =>
      connectAccount(
        t.db,
        vault,
        {
          orgId: t.orgId,
          ownerId: t.ownerId,
          provider: "mcp",
          alias: "bad",
          stdio,
          credential: { type: "static", value: TOKEN },
        },
        new Date(),
      );
    expect(connect).toThrow(ConnectError);
    expect(connect).toThrow(message);
  });

  it("runs long-lived with no output cap, in its own work root, with only its egress hosts", () => {
    const spec = stdioSandboxSpec(
      { transport: "stdio", ...STDIO, egress: ["api.notes.example"] },
      { workRoot: "/srv/heel/mcp/local-notes", credential: TOKEN },
    );
    expect(spec).toMatchObject({
      binary: process.execPath,
      workRoot: "/srv/heel/mcp/local-notes",
      cwd: "/srv/heel/mcp/local-notes",
      stdin: "pipe",
      secretEnv: { NOTES_TOKEN: TOKEN },
      readOnlyPaths: [FIXTURE],
      network: { kind: "egress", allow: ["api.notes.example"] },
      limits: { wallTimeMs: MAX_WALL_TIME_MS, maxOutputBytes: Number.MAX_SAFE_INTEGER },
    });
    expect(
      stdioSandboxSpec({ transport: "stdio", ...STDIO }, { workRoot: "/w", credential: null })
        .network,
    ).toEqual({ kind: "none" });
  });
});

/** A minimal normalized call on the account, for driving the definition directly. */
function callFor(account: { orgId: string; ownerId: string; alias: string; provider: string }) {
  return {
    orgId: account.orgId,
    agentId: "agt_test",
    ownerId: account.ownerId,
    surface: "mcp" as const,
    account: account.alias,
    provider: account.provider,
    tool: "",
    args: {},
    items: 1,
  };
}
