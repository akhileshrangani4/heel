import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findAccount } from "../../src/store/directory.ts";
import { type ConnectInput, configureAccount, connectAccount } from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { removeAccount, setAccountCredential } from "../../src/vault/manage.ts";
import { Vault } from "../../src/vault/vault.ts";
import { testStore } from "../helpers/store.ts";

/** `heel connect`: the provider each kind of account is stored under, and what it refuses. */

const BIN = realpathSync(process.execPath);
const OPENAPI = `openapi: 3.1.0
info: { title: Tickets, version: "1" }
paths:
  /tickets:
    get: { operationId: listTickets, x-heel-action: tickets.read, x-heel-kind: read }
`;
const KEY = { type: "static", value: "connect-test-key" } as const;
const URL_FLAGS = { url: "https://notes.example/mcp" };
const STDIO_FLAGS = {
  stdio: {
    command: BIN,
    args: [],
    egress: [],
    credentialEnv: "NOTES_TOKEN",
    credentialDelivery: "env" as const,
    mounts: [],
  },
};
const HTTP_FLAGS = {
  http: { baseUrl: "https://api.example.com/v1", auth: "bearer", openapi: OPENAPI },
};
const CLI_FLAGS = { cli: { command: "gh", bin: BIN, egress: [], credentialEnv: null } };

type Input = Omit<ConnectInput, "orgId" | "ownerId">;

function setUp(options: { vault?: boolean } = {}) {
  const t = testStore();
  const vault =
    options.vault === false
      ? null
      : Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  const connect = (input: Input) =>
    connectAccount(t.db, vault, { orgId: t.orgId, ownerId: t.ownerId, ...input }, new Date());
  return { t, vault, connect };
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

describe("connectAccount", () => {
  it.each<[string, Input, string, string]>([
    [
      "a remote MCP server",
      { provider: "mcp", alias: "notes", ...URL_FLAGS },
      "mcp:notes",
      "active",
    ],
    [
      "a remote MCP server that signs in",
      { provider: "mcp", alias: "notes", ...URL_FLAGS, oauth: true },
      "mcp:notes",
      "reconnect_required",
    ],
    [
      "a remote MCP server with a key",
      { provider: "mcp", alias: "notes", ...URL_FLAGS, credential: KEY },
      "mcp:notes",
      "active",
    ],
    [
      "a local MCP server",
      { provider: "mcp", alias: "notes", ...STDIO_FLAGS, credential: KEY },
      "mcp:notes",
      "active",
    ],
    [
      "an HTTP API",
      { provider: "http", alias: "tickets", ...HTTP_FLAGS, credential: KEY },
      "http:tickets",
      "active",
    ],
    [
      "a CLI, stored by its command",
      { provider: "cli", alias: "tool", ...CLI_FLAGS, credential: KEY },
      "cli:gh",
      "active",
    ],
    ["a built-in with no key", { provider: "github", alias: "gh" }, "github", "reconnect_required"],
    [
      "a built-in with a key",
      { provider: "github", alias: "gh", credential: KEY },
      "github",
      "active",
    ],
  ])("stores %s under its provider", (_, input, provider, status) => {
    const { t, connect } = setUp();
    const result = connect(input);
    expect(result).toEqual({
      accountId: expect.any(String),
      alias: input.alias,
      provider,
      status,
    });
    expect(findAccount(t.db, t.orgId, input.alias)).toMatchObject({
      id: result.accountId,
      provider,
      status,
    });
  });

  it.each<[string, Input, string, string]>([
    [
      "--url on a built-in",
      { provider: "github", alias: "gh", ...URL_FLAGS },
      "invalid_settings",
      "--url and --command are only for mcp accounts",
    ],
    [
      "--command on a built-in",
      { provider: "github", alias: "gh", ...STDIO_FLAGS },
      "invalid_settings",
      "--url and --command are only for mcp accounts",
    ],
    [
      "http flags on mcp",
      { provider: "mcp", alias: "notes", ...URL_FLAGS, ...HTTP_FLAGS },
      "invalid_settings",
      "--base-url and --openapi are only for http accounts",
    ],
    [
      "cli flags on http",
      { provider: "http", alias: "tickets", ...HTTP_FLAGS, ...CLI_FLAGS, credential: KEY },
      "invalid_settings",
      "--bin is only for cli accounts",
    ],
    [
      "mcp flags before http flags",
      { provider: "cli", alias: "tool", ...URL_FLAGS, ...HTTP_FLAGS, ...CLI_FLAGS },
      "invalid_settings",
      "--url and --command are only for mcp accounts",
    ],
    [
      "http flags before cli flags",
      { provider: "github", alias: "gh", ...CLI_FLAGS, ...HTTP_FLAGS },
      "invalid_settings",
      "--base-url and --openapi are only for http accounts",
    ],
    [
      "mcp flags on an unknown provider",
      { provider: "jira", alias: "jira", ...URL_FLAGS },
      "invalid_settings",
      "--url and --command are only for mcp accounts",
    ],
    [
      "mcp with neither --url nor --command",
      { provider: "mcp", alias: "notes" },
      "invalid_settings",
      "mcp needs either --url <upstream> or --command <path>",
    ],
    [
      "http with no http flags",
      { provider: "http", alias: "tickets", credential: KEY },
      "invalid_settings",
      "http needs --base-url, --auth and --openapi",
    ],
    [
      "cli with no cli flags",
      { provider: "cli", alias: "tool", credential: KEY },
      "invalid_settings",
      "cli needs <command> and --bin <path>",
    ],
    [
      "a bad alias",
      { provider: "github", alias: "Work" },
      "invalid_alias",
      "aliases are 1–64 lower-case letters, digits or '-', starting with a letter",
    ],
    [
      "a key for a provider that signs in",
      { provider: "gmail", alias: "mail", credential: KEY },
      "invalid_settings",
      "gmail signs in from the Connections page; give no credential",
    ],
  ])("refuses %s", (_, input, code, message) => {
    const { t, connect } = setUp();
    expect(() => connect(input)).toThrow(
      expect.objectContaining({ name: "ConnectError", code, message }),
    );
    expect(findAccount(t.db, t.orgId, input.alias)).toBeNull();
  });

  it.each(["jira", "mcp:notes", "constructor", "__proto__", "toString"])(
    "refuses the unknown provider %s",
    (provider) => {
      const { connect } = setUp();
      expect(() => connect({ provider, alias: "x" })).toThrow(
        expect.objectContaining({
          code: "unknown_provider",
          message: `unknown provider "${provider}"; use mcp, or a built-in provider: gmail, outlook, google-calendar, github, slack, linear, notion, stripe`,
        }),
      );
    },
  );

  it("refuses an alias already taken", () => {
    const { connect } = setUp();
    connect({ provider: "github", alias: "gh" });
    expect(() => connect({ provider: "slack", alias: "gh" })).toThrow(
      expect.objectContaining({
        code: "alias_taken",
        message: 'an account named "gh" already exists',
      }),
    );
  });

  it("writes nothing for a key while the vault is closed", () => {
    const { t, connect } = setUp({ vault: false });
    expect(() => connect({ provider: "github", alias: "gh", credential: KEY })).toThrow(
      expect.objectContaining({
        code: "vault_unavailable",
        message: "the vault is not open (no master key), so credentials cannot be stored",
      }),
    );
    expect(findAccount(t.db, t.orgId, "gh")).toBeNull();
  });

  it.each<[string, Input]>([
    ["a built-in", { provider: "github", alias: "gh" }],
    ["an HTTP API", { provider: "http", alias: "gh", ...HTTP_FLAGS }],
  ])("leaves no account behind when %s's key can't be stored", (_, input) => {
    const { t, connect } = setUp();
    const secret = "sk-never-in-an-error";
    const error = thrown(() =>
      connect({ ...input, credential: { type: "static", value: secret, extra: 1 } as never }),
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(/^invalid credential fields: /);
    expect((error as Error).message).not.toContain(secret);
    expect(findAccount(t.db, t.orgId, "gh")).toBeNull();
    // The alias is free again.
    expect(connect({ ...input, credential: KEY })).toMatchObject({ alias: "gh", status: "active" });
  });
});

describe("an account named by alias", () => {
  it.each<[string, (s: ReturnType<typeof setUp>) => unknown]>([
    [
      "heel account set --credential-host",
      ({ t, vault }) =>
        configureAccount(t.db, vault, t.orgId, "nope", {
          credentialHosts: ["api.example.com"],
          credentialAuth: null,
        }),
    ],
    ["heel account remove", ({ t }) => removeAccount(t.db, t.orgId, "nope", new Date())],
    [
      "heel account set --credential-stdin",
      ({ t, vault }) => setAccountCredential(t.db, vault, t.orgId, "nope", KEY),
    ],
  ])("%s refuses one that doesn't exist", (_, run) => {
    const s = setUp();
    expect(() => run(s)).toThrow(
      expect.objectContaining({
        name: "ConnectError",
        code: "not_found",
        message: 'no account named "nope"',
      }),
    );
  });
});
