import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";
import { upstreamSettings } from "../../src/definitions/mcp/settings.ts";
import { type StdioLauncher, UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { credentialDeliveryWarnings } from "../../src/security/exposure.ts";
import { findAccount } from "../../src/store/directory.ts";
import { accounts } from "../../src/store/schema.ts";
import {
  ConnectError,
  configureAccount,
  connectAccount,
  listAccounts,
} from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "../helpers/log.ts";
import { testStore } from "../helpers/store.ts";

/**
 * Credential hosts for local MCP servers: `heel connect mcp --credential-host`
 * and `heel account set`, which move the credential out of the server's
 * sandbox to heel's egress proxy, and how heel reports accounts that haven't.
 */

const FIXTURE = fileURLToPath(new URL("../fixtures/mcp/stdio-server.ts", import.meta.url));

const STDIO = {
  command: "/usr/bin/node",
  args: ["server.js"],
  egress: ["api.notes.example", "cdn.notes.example:8443"],
  credentialEnv: "NOTES_TOKEN",
  mounts: [],
};

function setUp() {
  const t = testStore();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  const connect = (alias: string, stdio: Record<string, unknown>) =>
    connectAccount(
      t.db,
      vault,
      {
        orgId: t.orgId,
        ownerId: t.ownerId,
        provider: "mcp",
        alias,
        stdio: { ...STDIO, ...stdio },
        credential: { type: "static", value: "notes-token-0123" },
      },
      new Date(),
    );
  return { t, vault, connect };
}

describe("heel connect mcp --credential-host", () => {
  it("stores the hosts and the auth, bearer by default", () => {
    const { t, connect } = setUp();
    connect("notes", { credentialHosts: ["api.notes.example"] });
    connect("keyed", {
      credentialHosts: ["cdn.notes.example:8443"],
      credentialAuth: "header:X-Key",
    });
    const settings = (alias: string) =>
      upstreamSettings(findAccount(t.db, t.orgId, alias)?.settings ?? {});
    expect(settings("notes")).toMatchObject({
      credentialHosts: ["api.notes.example"],
      credentialAuth: "bearer",
    });
    expect(settings("keyed")).toMatchObject({ credentialAuth: "header:X-Key" });
  });

  it.each([
    [
      "a host the server can't reach",
      { credentialHosts: ["evil.example"] },
      /isn't one of the server's --egress hosts/,
    ],
    [
      "the right host on another port",
      { credentialHosts: ["api.notes.example:8443"] },
      /isn't one of/,
    ],
    [
      "a query parameter",
      { credentialHosts: ["api.notes.example"], credentialAuth: "query:key" },
      /won't put a credential in a URL/,
    ],
    ["an auth with no hosts", { credentialAuth: "bearer" }, /needs --credential-host/],
    [
      "hosts with no variable for the placeholder",
      { credentialHosts: ["api.notes.example"], credentialEnv: null },
      /needs --credential-env/,
    ],
    [
      "a framing header",
      { credentialHosts: ["api.notes.example"], credentialAuth: "header:Host" },
      /bearer, basic or header/,
    ],
  ])("refuses %s", (_label, stdio, message) => {
    const { connect } = setUp();
    expect(() => connect("bad", stdio)).toThrow(ConnectError);
    expect(() => connect("bad", stdio)).toThrow(message);
  });
});

describe("heel account set", () => {
  it("moves an existing server's credential to the proxy without touching the stored credential", () => {
    const { t, vault, connect } = setUp();
    connect("notes", {});
    expect(listAccounts(t.db, t.orgId)[0]?.credentialDelivery).toBe("env");
    const configured = configureAccount(t.db, t.orgId, "notes", {
      credentialHosts: ["api.notes.example"],
      credentialAuth: null,
    });
    expect(configured).toEqual({ alias: "notes", credentialDelivery: "proxy" });
    const account = findAccount(t.db, t.orgId, "notes");
    expect(upstreamSettings(account?.settings ?? {})).toMatchObject({
      ...STDIO,
      credentialHosts: ["api.notes.example"],
      credentialAuth: "bearer",
    });
    expect(vault.get(account?.id ?? "")).toMatchObject({ type: "static" });
    expect(listAccounts(t.db, t.orgId)[0]?.credentialDelivery).toBe("proxy");
  });

  it("applies the same checks as connect", () => {
    const { t, connect } = setUp();
    connect("notes", {});
    expect(() =>
      configureAccount(t.db, t.orgId, "notes", {
        credentialHosts: ["evil.example"],
        credentialAuth: null,
      }),
    ).toThrow(/isn't one of/);
    expect(() =>
      configureAccount(t.db, t.orgId, "notes", { credentialHosts: [], credentialAuth: null }),
    ).toThrow(/at least one/);
  });

  it("refuses accounts that aren't local MCP servers, and unknown ones", () => {
    const { t, vault } = setUp();
    connectAccount(
      t.db,
      vault,
      {
        orgId: t.orgId,
        ownerId: t.ownerId,
        provider: "mcp",
        alias: "remote",
        url: "https://mcp.example/mcp",
      },
      new Date(),
    );
    const set = (alias: string) => () =>
      configureAccount(t.db, t.orgId, alias, {
        credentialHosts: ["api.notes.example"],
        credentialAuth: null,
      });
    expect(set("remote")).toThrow(/only local MCP servers/);
    expect(set("missing")).toThrow(expect.objectContaining({ code: "not_found" }));
  });

  it("replaces a running server whose settings changed, so the old environment doesn't outlive the change", async () => {
    const { t, vault, connect } = setUp();
    connect("notes", {});
    const launches: (string | null)[] = [];
    const killed: number[] = [];
    // The fixture server as a plain child process; the settings it was started with are recorded.
    const launch: StdioLauncher = async (_account, upstream) => {
      const index = launches.push(upstream.credentialHosts.join(",") || null) - 1;
      const child = spawn(process.execPath, [FIXTURE], { stdio: ["pipe", "pipe", "pipe"] });
      onTestFinished(() => {
        child.kill();
      });
      return {
        stdin: child.stdin,
        stdout: child.stdout,
        stderr: child.stderr,
        done: new Promise((resolve) => child.once("exit", resolve)),
        kill: () => {
          killed.push(index);
          child.kill();
        },
      };
    };
    const pool = new UpstreamPool({ vault, log: captureLogger().logger, launchStdio: launch });
    onTestFinished(() => pool.close());
    const signal = AbortSignal.timeout(10_000);
    const before = findAccount(t.db, t.orgId, "notes");
    if (before === null) throw new Error("no account");
    await pool.listTools(before, signal);
    await pool.listTools(before, signal);
    expect(launches).toEqual([null]);
    configureAccount(t.db, t.orgId, "notes", {
      credentialHosts: ["api.notes.example"],
      credentialAuth: null,
    });
    const after = findAccount(t.db, t.orgId, "notes");
    if (after === null) throw new Error("no account");
    await pool.listTools(after, signal);
    expect(launches).toEqual([null, "api.notes.example"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(killed).toEqual([0]);
  });
});

describe("credential delivery in account list and startup warnings", () => {
  it("marks gh as proxy, other CLIs and unmigrated local servers as env, and the rest as null", () => {
    const { t, connect } = setUp();
    connect("migrated", { credentialHosts: ["api.notes.example"] });
    connect("legacy", {});
    connectAccount(
      t.db,
      null,
      { orgId: t.orgId, ownerId: t.ownerId, provider: "gmail", alias: "mail" },
      new Date(),
    );
    // CLI accounts, as connect stores them (connect itself checks the binary exists).
    for (const [alias, settings] of [
      [
        "gh",
        {
          transport: "cli",
          command: "gh",
          bin: "/usr/bin/gh",
          egress: ["api.github.com"],
          credentialEnv: null,
        },
      ],
      [
        "npm",
        {
          transport: "cli",
          command: "npm",
          bin: "/usr/bin/npm",
          egress: [],
          credentialEnv: "NPM_TOKEN",
        },
      ],
    ] as const) {
      connectAccount(
        t.db,
        null,
        { orgId: t.orgId, ownerId: t.ownerId, provider: "gmail", alias },
        new Date(),
      );
      t.db
        .update(accounts)
        .set({ provider: `cli:${alias}`, settings })
        .where(eq(accounts.alias, alias))
        .run();
    }
    const delivery = Object.fromEntries(
      listAccounts(t.db, t.orgId).map((a) => [a.alias, a.credentialDelivery]),
    );
    expect(delivery).toEqual({
      gh: "proxy",
      legacy: "env",
      mail: null,
      migrated: "proxy",
      npm: "env",
    });
  });

  it("warns once per account whose program holds the credential, saying how to move it", () => {
    const warnings = credentialDeliveryWarnings([
      { alias: "legacy", kind: "mcp", delivery: "env" },
      { alias: "npm", kind: "cli", delivery: "env" },
      { alias: "migrated", kind: "mcp", delivery: "proxy" },
      { alias: "mail", kind: "mcp", delivery: null },
    ]);
    expect(warnings.map((w) => w.code)).toEqual(["credential_in_sandbox", "credential_in_sandbox"]);
    expect(warnings[0]?.message).toContain("heel account set legacy --credential-host");
    expect(warnings[1]?.message).toContain('"npm"');
  });
});
