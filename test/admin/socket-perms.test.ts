import { execFile, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, lstatSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { AdminClientError, adminCall } from "../../src/admin/client.ts";
import { createAdminHandler } from "../../src/admin/handlers.ts";
import {
  ADMIN_MAX_REQUEST_BYTES,
  type AdminRequest,
  type AdminResponse,
} from "../../src/admin/protocol.ts";
import {
  ADMIN_SOCKET_MODE,
  type AdminHandler,
  AdminSocketError,
  startAdminServer,
} from "../../src/admin/server.ts";
import { authenticateAgent } from "../../src/gateway/agent-tokens.ts";
import { createLogger, type Logger } from "../../src/log.ts";
import { credentials } from "../../src/store/schema.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "../helpers/log.ts";
import { type TestStore, tempDir, testStore } from "../helpers/store.ts";

const silent = createLogger("silent");

function handlerFor(t: TestStore, vault: Vault | null = null): AdminHandler {
  return createAdminHandler({ db: t.db, orgId: t.orgId, vault, version: "test" });
}

async function serve(
  options: { dir?: string; log?: Logger; vault?: boolean } = {},
): Promise<{ t: TestStore; path: string; close: () => Promise<void> }> {
  const t = testStore();
  const dir = options.dir ?? tempDir("heel-sock-");
  const path = join(dir, "admin.sock");
  const vault = options.vault
    ? Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" })
    : null;
  const server = await startAdminServer({
    path,
    handle: handlerFor(t, vault),
    log: options.log ?? silent,
  });
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    await server.close();
  };
  onTestFinished(close);
  return { t, path, close };
}

/** Sends raw bytes and resolves with heel's raw reply. */
function rawExchange(path: string, payload: string | Buffer): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const socket = connect(path, () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    socket.on("error", reject);
  });
}

async function call(path: string, request: AdminRequest): Promise<AdminResponse> {
  return adminCall(path, request);
}

function resultOf(response: AdminResponse): unknown {
  if (!response.ok) {
    throw new Error(`expected ok, got ${response.error.code}: ${response.error.message}`);
  }
  return response.result;
}

/** Absolute path to python3, so it still resolves under sudo's secure_path. */
function python3(): string | null {
  const found = spawnSync("sh", ["-c", "command -v python3"], { encoding: "utf8" });
  const path = found.stdout.trim();
  return found.status === 0 && path ? path : null;
}

const PYTHON = python3();

/** Leaves a socket file that nobody listens on, as a crashed heel would. */
function leaveStaleSocket(path: string): void {
  if (!PYTHON) throw new Error("python3 is needed to create a stale socket");
  const made = spawnSync(PYTHON, [
    "-c",
    "import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])",
    path,
  ]);
  if (made.status !== 0) throw new Error(`could not create a stale socket: ${made.stderr}`);
}

/** Can this host run a command as `nobody`? CI must be able to; elsewhere the test is skipped. */
const canRunAsNobody =
  PYTHON !== null && spawnSync("sudo", ["-n", "-u", "nobody", "true"]).status === 0;
const mustRunAsNobody = process.env["CI"] === "true";

/** Connects to `path` as the `nobody` user; resolves with the outcome python reports. */
function connectAsNobody(path: string): Promise<{ connected: boolean; error: string }> {
  const script = [
    "import socket,sys",
    "s=socket.socket(socket.AF_UNIX)",
    "try:",
    "    s.connect(sys.argv[1]); print('connected')",
    "except OSError as e:",
    "    print(type(e).__name__)",
  ].join("\n");
  return new Promise((resolve, reject) => {
    execFile(
      "sudo",
      ["-n", "-u", "nobody", PYTHON ?? "python3", "-c", script, path],
      { encoding: "utf8", timeout: 10_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        const outcome = stdout.trim();
        resolve({ connected: outcome === "connected", error: outcome });
      },
    );
  });
}

describe("admin socket permissions", () => {
  it("binds the socket with mode 0600, owned by the heel user", async () => {
    const { path } = await serve();
    const stat = lstatSync(path);
    expect(stat.isSocket()).toBe(true);
    expect(stat.mode & 0o777).toBe(ADMIN_SOCKET_MODE);
    expect(stat.uid).toBe(process.getuid?.());
  });

  it.skipIf(!canRunAsNobody && !mustRunAsNobody)(
    "refuses a connection from another Unix user",
    async () => {
      const dir = tempDir("heel-sock-");
      // Let other users reach the directory, so only the socket's own mode
      // stands between them and heel.
      chmodSync(dir, 0o755);
      const { path } = await serve({ dir });

      const refused = await connectAsNobody(path);
      expect(refused).toEqual({ connected: false, error: "PermissionError" });

      // Control: the same user does connect once the socket is opened up, so
      // the refusal above came from the 0600 mode and nothing else.
      chmodSync(path, 0o666);
      expect(await connectAsNobody(path)).toMatchObject({ connected: true });
    },
  );

  it("creates a missing socket directory with mode 0700", async () => {
    const dir = join(tempDir("heel-sock-"), "run", "heel");
    await serve({ dir });
    expect(lstatSync(dir).mode & 0o777).toBe(0o700);
  });

  it("refuses a socket directory that other users can write to", async () => {
    const dir = tempDir("heel-sock-");
    chmodSync(dir, 0o777);
    await expect(serve({ dir })).rejects.toThrow(AdminSocketError);
  });

  it("refuses to take over a socket another heel is listening on", async () => {
    const { t, path } = await serve();
    await expect(startAdminServer({ path, handle: handlerFor(t), log: silent })).rejects.toThrow(
      /already listening/,
    );
    // The live server is untouched.
    expect(resultOf(await call(path, { method: "ping" }))).toMatchObject({ version: "test" });
  });

  it.skipIf(PYTHON === null)("replaces a stale socket left by a crash", async () => {
    const t = testStore();
    const path = join(tempDir("heel-sock-"), "admin.sock");
    leaveStaleSocket(path);
    const server = await startAdminServer({ path, handle: handlerFor(t), log: silent });
    onTestFinished(() => server.close());
    expect(lstatSync(path).mode & 0o777).toBe(ADMIN_SOCKET_MODE);
    expect(resultOf(await call(path, { method: "ping" }))).toMatchObject({ version: "test" });
  });

  it("never deletes a file at the socket path that is not a socket", async () => {
    const t = testStore();
    const path = join(tempDir("heel-sock-"), "admin.sock");
    writeFileSync(path, "keep me");
    await expect(startAdminServer({ path, handle: handlerFor(t), log: silent })).rejects.toThrow(
      /not a socket/,
    );
    expect(lstatSync(path).isFile()).toBe(true);
  });

  it("reports a missing server as not running", async () => {
    const path = join(tempDir("heel-sock-"), "admin.sock");
    const error = await call(path, { method: "ping" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AdminClientError);
    expect((error as AdminClientError).failure).toBe("not_running");
  });
});

describe("admin socket requests", () => {
  it("adds an agent whose token authenticates, and rejects a duplicate name", async () => {
    const { t, path } = await serve();
    const added = resultOf(
      await call(path, { method: "agent.add", params: { name: "inbox-bot" } }),
    );
    expect(added).toMatchObject({ name: "inbox-bot", token: expect.stringMatching(/^heel_/) });
    const { token } = added as { token: string };

    const auth = authenticateAgent(t.db, `Bearer ${token}`);
    expect(auth).toMatchObject({ ok: true, agent: { agentName: "inbox-bot", ownerId: t.ownerId } });

    const again = await call(path, { method: "agent.add", params: { name: "inbox-bot" } });
    expect(again).toMatchObject({ ok: false, error: { code: "conflict" } });
  });

  it("revokes an agent so its token stops authenticating", async () => {
    const { t, path } = await serve();
    const { token } = resultOf(
      await call(path, { method: "agent.add", params: { name: "ci-bot" } }),
    ) as { token: string };
    resultOf(await call(path, { method: "agent.revoke", params: { name: "ci-bot" } }));
    expect(authenticateAgent(t.db, `Bearer ${token}`)).toEqual({ ok: false, failure: "revoked" });

    const missing = await call(path, { method: "agent.revoke", params: { name: "nobody" } });
    expect(missing).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("rejects an unknown owner", async () => {
    const { path } = await serve();
    const response = await call(path, {
      method: "agent.add",
      params: { name: "inbox-bot", owner: "mallory" },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  it("answers malformed and oversized requests with bad_request", async () => {
    const { path } = await serve();
    const notJson = JSON.parse(await rawExchange(path, "{nope\n"));
    expect(notJson).toMatchObject({ ok: false, error: { code: "bad_request" } });

    const unknownMethod = JSON.parse(await rawExchange(path, '{"method":"rules.reload"}\n'));
    expect(unknownMethod).toMatchObject({ ok: false, error: { code: "bad_request" } });

    const huge = Buffer.alloc(ADMIN_MAX_REQUEST_BYTES + 1, 0x61);
    const tooLarge = JSON.parse(await rawExchange(path, huge));
    expect(tooLarge).toMatchObject({ ok: false, error: { code: "bad_request" } });
  });

  it("I-02: a credential sent to heel connect is never logged or echoed", async () => {
    const secret = `ghp_${randomBytes(18).toString("hex")}`;
    const { logger, output } = captureLogger();
    const { t, path } = await serve({ log: logger, vault: true });

    const connected = await call(path, {
      method: "account.connect",
      params: {
        provider: "github",
        alias: "github",
        credential: { type: "static", value: secret },
      },
    });
    expect(resultOf(connected)).toMatchObject({ alias: "github", status: "active" });

    // A malformed request carrying the same value is refused without echoing it.
    const bad = await rawExchange(
      path,
      `${JSON.stringify({ method: "account.connect", params: { alias: 7, credential: { type: "static", value: secret } } })}\n`,
    );
    expect(JSON.parse(bad)).toMatchObject({ ok: false, error: { code: "bad_request" } });
    expect(bad).not.toContain(secret);

    expect(output()).toContain('"method":"account.connect"');
    expect(output()).not.toContain(secret);
    const stored = t.db.select().from(credentials).all();
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(secret);
  });

  it("refuses to store a credential when the vault is not open", async () => {
    const { t, path } = await serve({ vault: false });
    const response = await call(path, {
      method: "account.connect",
      params: { provider: "github", alias: "github", credential: { type: "static", value: "x" } },
    });
    expect(response).toMatchObject({ ok: false, error: { code: "vault_unavailable" } });
    expect(resultOf(await call(path, { method: "account.list" }))).toEqual([]);
    expect(t.db.select().from(credentials).all()).toEqual([]);
  });

  it("registers an account without a credential as reconnect_required", async () => {
    const { path } = await serve({ vault: false });
    const connected = resultOf(
      await call(path, {
        method: "account.connect",
        params: { provider: "gmail", alias: "gmail-work" },
      }),
    );
    expect(connected).toMatchObject({ alias: "gmail-work", status: "reconnect_required" });

    const invalid = await call(path, {
      method: "account.connect",
      params: { provider: "gmail", alias: "Gmail_Work" },
    });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid" } });
    const unknown = await call(path, {
      method: "account.connect",
      params: { provider: "myspace", alias: "old" },
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: "invalid" } });
  });
});
