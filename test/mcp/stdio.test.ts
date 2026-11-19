import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { hidingFor, UNSURE_JUDGE } from "../../src/core/hide.ts";
import { mcpPassthrough } from "../../src/definitions/mcp/passthrough.ts";
import {
  MAX_MESSAGE_BYTES,
  MessageTooLargeError,
  SandboxStdioTransport,
  type StdioProcess,
} from "../../src/definitions/mcp/sandbox-transport.ts";
import { stdioSandboxSpec, upstreamSettings } from "../../src/definitions/mcp/settings.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { UpstreamError } from "../../src/gateway/pipeline/ports.ts";
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
  credentialHosts: [],
  credentialAuth: null,
  // Most of these tests are about the server, not delivery: it gets the credential itself, by choice.
  credentialDelivery: "env" as const,
  mounts: [FIXTURE],
};

/** Starts the fixture the way the sandbox would, with the credential in its environment. */
async function launchChild(
  _account: unknown,
  _settings: unknown,
  credential: (() => Promise<string>) | null,
): Promise<StdioProcess> {
  const value = credential === null ? null : await credential();
  const child = spawn(process.execPath, [FIXTURE], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      PATH: process.env["PATH"] ?? "",
      ...(value === null ? {} : { NOTES_TOKEN: value }),
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
  const log = captureLogger();
  let launches = 0;
  const pool = new UpstreamPool({
    vault,
    log: log.logger,
    ...(options.launch !== false && {
      launchStdio: (account, settings, credential) => {
        launches++;
        return launchChild(account, settings, credential);
      },
    }),
  });
  onTestFinished(() => pool.close());
  const account = findAccount(t.db, t.orgId, "local-notes");
  if (account === null) throw new Error("no account");
  return { t, pool, account, log: log.output, launches: () => launches };
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
      "big",
      "request",
      "sweep",
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

  it("fails only the call whose response is too large, and restarts the server for the next", async () => {
    const { pool, account, log, launches } = setUp();
    const definition = mcpPassthrough(account, pool);
    const signal = AbortSignal.timeout(10_000);
    const started = Date.now();

    const failed = definition
      .execute(
        { ...callFor(account), tool: "big", args: { bytes: MAX_MESSAGE_BYTES + 1024 } },
        signal,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    const error = await failed;
    expect(error).toBeInstanceOf(UpstreamError);
    expect((error as UpstreamError).body).toEqual({
      error: expect.stringMatching(/more than 10 MB/),
    });
    // Failed when the connection dropped, not when the call timed out.
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(log()).toContain("too large to read");

    const result = await definition.execute(
      { ...callFor(account), tool: "echo", args: { text: "still here" } },
      signal,
    );
    expect(result).toMatchObject({ content: [{ type: "text", text: "still here" }] });
    expect(launches()).toBe(2);
  });

  it("denies calls when the host can't run the sandbox", async () => {
    const { pool, account } = setUp({ launch: false });
    const normalized = await mcpPassthrough(account, pool).normalize(
      { ...callFor(account), tool: "echo", args: {} },
      { signal: AbortSignal.timeout(10_000), hide: hidingFor([], UNSURE_JUDGE) },
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

  it("runs long-lived with no output cap, in its own work root, with only its egress hosts", async () => {
    const spec = await stdioSandboxSpec(
      { transport: "stdio", ...STDIO, egress: ["api.notes.example"] },
      { workRoot: "/srv/heel/mcp/local-notes", credential: async () => TOKEN },
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
      (
        await stdioSandboxSpec(
          { transport: "stdio", ...STDIO },
          { workRoot: "/w", credential: null },
        )
      ).network,
    ).toEqual({ kind: "none" });
  });

  it("with credential hosts, gives the server a placeholder and its proxy a way to read the credential", async () => {
    let reads = 0;
    const credential = async () => {
      reads++;
      return TOKEN;
    };
    const spec = await stdioSandboxSpec(
      {
        transport: "stdio",
        ...STDIO,
        egress: ["api.notes.example", "cdn.notes.example"],
        credentialHosts: ["api.notes.example"],
        credentialAuth: "header:X-Notes-Key",
      },
      { workRoot: "/w", credential },
    );
    expect(spec.secretEnv).toBeUndefined();
    const placeholder = spec.env?.["NOTES_TOKEN"];
    expect(placeholder).toMatch(/^heel-placeholder-[0-9a-f]+$/);
    expect(spec.network).toMatchObject({
      kind: "egress",
      allow: ["api.notes.example", "cdn.notes.example"],
      inject: {
        hosts: ["api.notes.example"],
        auth: { type: "header", name: "x-notes-key" },
        placeholder,
      },
    });
    // Nothing read it while building the spec; only the proxy will, per request.
    expect(reads).toBe(0);
    expect(JSON.stringify(spec)).not.toContain(TOKEN);
  });
});

describe("the stdio transport", () => {
  it("drops the connection on a message too large to read, and reads nothing after it", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const stdin = new PassThrough();
    let killed = false;
    let exit: () => void = () => {};
    const transport = new SandboxStdioTransport(
      {
        stdin,
        stdout,
        stderr,
        done: new Promise<void>((resolve) => {
          exit = resolve;
        }),
        kill: () => {
          killed = true;
        },
      },
      () => {},
      1024,
    );
    const messages: unknown[] = [];
    const errors: Error[] = [];
    let closes = 0;
    transport.onmessage = (message) => messages.push(message);
    transport.onerror = (error) => errors.push(error);
    transport.onclose = () => closes++;
    await transport.start();

    // Over the cap with no newline yet: before the fix this threw out of the data handler.
    expect(() => stdout.emit("data", Buffer.from("x".repeat(2048)))).not.toThrow();
    // What follows could be the tail of that message dressed as an answer; it is never read.
    stdout.emit(
      "data",
      Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [] } })}\n`),
    );

    expect(messages).toEqual([]);
    expect(errors.map((error) => error.name)).toEqual(["MessageTooLargeError"]);
    expect(transport.failure).toBeInstanceOf(MessageTooLargeError);
    expect(killed).toBe(true);
    expect(closes).toBe(1);
    await expect(transport.send({ jsonrpc: "2.0", id: 2, method: "ping" })).rejects.toBeInstanceOf(
      MessageTooLargeError,
    );
    // The process exiting afterwards doesn't close it twice.
    exit();
    await new Promise((resolve) => setImmediate(resolve));
    expect(closes).toBe(1);
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
