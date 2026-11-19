import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { hidingFor, UNSURE_JUDGE } from "../../src/core/hide.ts";
import { credentialSpec } from "../../src/definitions/cli/definition.ts";
import { npmRegistryKey, npmUserConfig } from "../../src/definitions/cli/npm.ts";
import { cliSettings } from "../../src/definitions/cli/settings.ts";
import { CredentialDeliveryRefused } from "../../src/definitions/credential-delivery.ts";
import { mcpPassthrough } from "../../src/definitions/mcp/passthrough.ts";
import { stdioSandboxSpec, upstreamSettings } from "../../src/definitions/mcp/settings.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { decisionFor } from "../../src/gateway/mcp/results.ts";
import { planSandbox, type SandboxHost } from "../../src/runner/plan.ts";
import { findAccount } from "../../src/store/directory.ts";
import { accounts } from "../../src/store/schema.ts";
import {
  ConnectError,
  type ConnectInput,
  configureAccount,
  connectAccount,
  listAccounts,
} from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { cliPipeline } from "../helpers/cli-pipeline.ts";
import { captureLogger } from "../helpers/log.ts";
import { testStore } from "../helpers/store.ts";

/**
 * Credential delivery for local MCP servers and CLIs other than gh (spec:
 * CLI runner, "Credential delivery"): with credential hosts the program gets
 * a placeholder (npm, in the user config heel writes too); without them the
 * credential goes into its environment only when the operator chose that
 * (`--credential-delivery env`), and otherwise every call is refused, with
 * the commands that fix it. Accounts stored before the choice existed load
 * fine and land in the refused case.
 */

/** A low-entropy stand-in credential. */
const TOKEN = "heel-test-token-aaaa";
const BIN = realpathSync(process.execPath);
const HOST: SandboxHost = {
  bwrap: "/usr/bin/bwrap",
  prlimit: "/usr/bin/prlimit",
  node: "/opt/node/bin/node",
  relay: "/opt/heel/src/runner/relay.ts",
  arch: "x64",
  systemDirs: [],
};

/** A CLI account exactly as `heel connect cli` stored it before delivery was a choice. */
const LEGACY_CLI = {
  transport: "cli",
  command: "terraform",
  bin: "/usr/bin/terraform",
  egress: ["app.terraform.io"],
  credentialEnv: "TF_TOKEN",
};

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

const allowAll = (command: string) =>
  `rules:\n  - match: { command: ${command} }\n    then: allow\n`;

describe("a CLI whose credential would go into its environment, unchosen", () => {
  it("is refused before any rule, naming both fixes, and nothing starts", async () => {
    const h = cliPipeline({
      owner: allowAll("terraform"),
      settings: LEGACY_CLI,
      credential: TOKEN,
    });
    const answer = await h.run({ argv: ["terraform", "plan"], cwd: h.repo });
    expect(answer.status).toBe(403);
    expect(answer.body).toMatchObject({ status: "denied", reason: "credential_delivery" });
    const message = String(answer.body["message"]);
    expect(message).toContain(
      'account "github" would put its credential in its CLI\'s environment',
    );
    expect(message).toContain(
      "heel account set github --credential-host <host> --credential-auth bearer|basic|header:<Name>",
    );
    expect(message).toContain("heel account set github --credential-delivery env");
    expect(h.started).toEqual([]);
    expect(JSON.stringify(answer.body)).not.toContain(TOKEN);
  });

  it("loads with the new fields defaulted, so nothing crashes on an old row", () => {
    expect(cliSettings(LEGACY_CLI)).toMatchObject({
      credentialHosts: [],
      credentialAuth: null,
      credentialDelivery: null,
    });
  });

  it("can't get a sandbox spec either: the spec builder refuses it too", () => {
    const settings = cliSettings(LEGACY_CLI);
    if (settings === null) throw new Error("bad settings");
    expect(() =>
      credentialSpec(settings, TOKEN, async () => TOKEN, undefined, "terraform"),
    ).toThrow(CredentialDeliveryRefused);
  });
});

describe("--credential-delivery env, the escape hatch", () => {
  it("runs the CLI with the credential in its variable, as before", async () => {
    const h = cliPipeline({
      owner: allowAll("terraform"),
      settings: { ...LEGACY_CLI, credentialDelivery: "env" },
      credential: TOKEN,
    });
    const answer = await h.run({ argv: ["terraform", "plan"], cwd: h.repo });
    expect(answer.body["status"]).toBe("ran");
    const [spec] = h.started;
    expect(spec?.secretEnv).toEqual({ TF_TOKEN: TOKEN });
    expect(spec?.network).toEqual({ kind: "egress", allow: ["app.terraform.io"] });
  });
});

describe("a CLI with credential hosts", () => {
  it("gets a placeholder in its variable, and heel's proxy the credential for those hosts", async () => {
    const h = cliPipeline({
      owner: allowAll("terraform"),
      settings: {
        ...LEGACY_CLI,
        egress: ["app.terraform.io", "registry.terraform.io"],
        credentialHosts: ["app.terraform.io"],
        credentialAuth: "bearer",
        credentialDelivery: "proxy",
      },
      credential: TOKEN,
    });
    const answer = await h.run({ argv: ["terraform", "plan"], cwd: h.repo });
    expect(answer.body["status"]).toBe("ran");
    const [spec] = h.started;
    if (spec === undefined) throw new Error("nothing started");
    expect(spec.secretEnv).toBeUndefined();
    const placeholder = spec.env?.["TF_TOKEN"];
    expect(placeholder).toMatch(/^heel-placeholder-[0-9a-f]+$/);
    const network = spec.network?.kind === "egress" ? spec.network : undefined;
    expect(network?.allow).toEqual(["app.terraform.io", "registry.terraform.io"]);
    expect(network?.inject).toMatchObject({
      hosts: ["app.terraform.io"],
      auth: { type: "authorization", schemes: ["bearer"] },
      placeholder,
    });
    expect(await network?.inject?.credential()).toBe(TOKEN);
    // The host-side scrub still knows it, in case an upstream echoes it.
    expect(spec.secrets).toContain(TOKEN);
  });
});

describe("npm with credential hosts", () => {
  const NPM = {
    transport: "cli",
    command: "npm",
    bin: "/usr/bin/npm",
    egress: ["registry.npmjs.org", "npm.internal.example:8443"],
    credentialEnv: null,
    credentialHosts: ["registry.npmjs.org", "npm.internal.example:8443"],
    credentialAuth: "bearer",
    credentialDelivery: "proxy",
  };

  it("gets a user config whose token for each credential host is the placeholder, and the CA bundle as cafile", async () => {
    const h = cliPipeline({ owner: allowAll("npm"), settings: NPM, credential: TOKEN });
    const answer = await h.run({ argv: ["npm", "whoami"], cwd: h.repo });
    expect(answer.body["status"]).toBe("ran");
    const [spec] = h.started;
    if (spec === undefined) throw new Error("nothing started");
    const network = spec.network?.kind === "egress" ? spec.network : undefined;
    const placeholder = network?.inject?.placeholder ?? "";
    expect(placeholder).toMatch(/^heel-placeholder-/);
    expect(spec.env).toEqual({ NPM_CONFIG_USERCONFIG: "/heel/run/npmrc" });
    expect(spec.files).toEqual([
      {
        name: "npmrc",
        content:
          "; Written by heel. The tokens here are placeholders: heel adds the real one on the wire.\n" +
          `//registry.npmjs.org/:_authToken=${placeholder}\n` +
          `//npm.internal.example:8443/:_authToken=${placeholder}\n` +
          "cafile=/heel/run/ca.pem\n",
      },
    ]);
    expect(network?.inject?.auth).toEqual({ type: "authorization", schemes: ["bearer"] });

    // The plan mounts it read-only at /heel/run/npmrc, and nothing in the sandbox can set the variable otherwise.
    const plan = planSandbox(HOST, spec, new Uint8Array(8), "/tmp/heel-egress/egress.sock", "PEM");
    expect(plan.options.join(" ")).toContain("/heel/run/npmrc");
    expect(plan.options.join("\0")).toContain("--setenv\0NPM_CONFIG_USERCONFIG\0/heel/run/npmrc");
    expect(plan.options.join("\0")).toContain("--setenv\0NODE_EXTRA_CA_CERTS\0/heel/run/ca.pem");
  });

  it("puts the placeholder in a credential variable too, for a project .npmrc that reads NPM_TOKEN", async () => {
    const h = cliPipeline({
      owner: allowAll("npm"),
      settings: { ...NPM, credentialEnv: "NPM_TOKEN" },
      credential: TOKEN,
    });
    await h.run({ argv: ["npm", "ci"], cwd: h.repo });
    const [spec] = h.started;
    const network = spec?.network?.kind === "egress" ? spec.network : undefined;
    expect(spec?.env).toEqual({
      NPM_TOKEN: network?.inject?.placeholder,
      NPM_CONFIG_USERCONFIG: "/heel/run/npmrc",
    });
  });

  it("keys each host the way npm looks it up: no port for 443, brackets for IPv6", () => {
    expect(npmRegistryKey("registry.npmjs.org")).toBe("//registry.npmjs.org/");
    expect(npmRegistryKey("registry.npmjs.org:443")).toBe("//registry.npmjs.org/");
    expect(npmRegistryKey("127.0.0.1:4873")).toBe("//127.0.0.1:4873/");
    expect(npmRegistryKey("[::1]:4873")).toBe("//[::1]:4873/");
    expect(npmUserConfig(["a.example"], "heel-placeholder-00")).toContain(
      "//a.example/:_authToken=heel-placeholder-00\n",
    );
  });
});

describe("a local MCP server whose credential would go into its environment, unchosen", () => {
  /** Exactly as `heel connect mcp --command` stored it before delivery was a choice. */
  const LEGACY_STDIO = {
    transport: "stdio",
    command: "/usr/bin/node",
    args: ["server.js"],
    egress: ["api.notes.example"],
    credentialEnv: "NOTES_TOKEN",
    credentialHosts: [],
    credentialAuth: null,
    mounts: [],
  };

  function setUp() {
    const t = testStore();
    const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
    connectAccount(
      t.db,
      vault,
      {
        orgId: t.orgId,
        ownerId: t.ownerId,
        provider: "mcp",
        alias: "notes",
        url: "https://placeholder.example/mcp",
      },
      new Date(),
    );
    const id = findAccount(t.db, t.orgId, "notes")?.id ?? "";
    vault.put(id, { type: "static", value: TOKEN });
    // Rewrite the row to the old stdio shape, as an upgraded install would have it.
    t.db.update(accounts).set({ settings: LEGACY_STDIO }).where(eq(accounts.id, id)).run();
    const account = findAccount(t.db, t.orgId, "notes");
    if (account === null) throw new Error("no account");
    let launches = 0;
    const pool = new UpstreamPool({
      vault,
      log: captureLogger().logger,
      launchStdio: async () => {
        launches++;
        throw new Error("must not start");
      },
    });
    return { t, vault, account, pool, launches: () => launches };
  }

  it("loads, lists as refused, and never starts: its tools aren't listed and a call is refused with the fix", async () => {
    const { t, account, pool, launches } = setUp();
    expect(upstreamSettings(account.settings)).toMatchObject({ credentialDelivery: null });
    expect(listAccounts(t.db, t.orgId)[0]?.credentialDelivery).toBe("refused");
    const definition = mcpPassthrough(account, pool);
    // Not started to list tools: it has none to offer until the operator fixes it.
    expect(await definition.tools?.(AbortSignal.timeout(1_000))).toEqual([]);
    const normalized = await definition.normalize(
      { ...callFor(account), tool: "echo", args: {} },
      { signal: AbortSignal.timeout(1_000), hide: hidingFor([], UNSURE_JUDGE) },
    );
    expect(normalized).toMatchObject({ ok: false, reason: "credential_delivery" });
    const detail = normalized.ok ? "" : (normalized.detail ?? "");
    expect(detail).toContain("its local MCP server's environment");
    expect(detail).toContain("heel account set notes --credential-delivery env");
    expect(launches()).toBe(0);

    // What the agent reads over MCP carries the fix.
    const decision = decisionFor(
      { status: "denied", reason: "credential_delivery", rule: null, detail },
      { account: "notes", tool: "echo", native: false },
    );
    expect(decision.message).toBe(`heel denied echo on notes (credential delivery). ${detail}`);
  });

  it("can't get a sandbox spec either", async () => {
    const { account } = setUp();
    const upstream = upstreamSettings(account.settings);
    if (upstream?.transport !== "stdio") throw new Error("not stdio");
    await expect(
      stdioSandboxSpec(upstream, { workRoot: "/w", credential: async () => TOKEN, alias: "notes" }),
    ).rejects.toThrow(CredentialDeliveryRefused);
  });

  it("works again once the operator names credential hosts, and asks for a rotation", () => {
    const { t, vault } = setUp();
    const configured = configureAccount(t.db, vault, t.orgId, "notes", {
      credentialHosts: ["api.notes.example"],
      credentialAuth: null,
    });
    expect(configured).toMatchObject({ credentialDelivery: "proxy", rotate: true });
  });

  it("or once the operator chooses env delivery, with no rotation asked", () => {
    const { t, vault } = setUp();
    const configured = configureAccount(t.db, vault, t.orgId, "notes", {
      credentialHosts: [],
      credentialAuth: null,
      credentialDelivery: "env",
    });
    expect(configured).toMatchObject({ credentialDelivery: "env", rotate: false });
    expect(upstreamSettings(findAccount(t.db, t.orgId, "notes")?.settings ?? {})).toMatchObject({
      credentialHosts: [],
      credentialAuth: null,
      credentialDelivery: "env",
    });
  });
});

describe("heel connect cli and heel account set, for credential delivery", () => {
  function connect(cli: Partial<NonNullable<ConnectInput["cli"]>>, alias = "tool") {
    const t = testStore();
    const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
    const run = (more: Partial<NonNullable<ConnectInput["cli"]>>, as = alias) =>
      connectAccount(
        t.db,
        vault,
        {
          orgId: t.orgId,
          ownerId: t.ownerId,
          provider: "cli",
          alias: as,
          cli: {
            command: "terraform",
            bin: BIN,
            egress: ["app.terraform.io"],
            credentialEnv: "TF_TOKEN",
            ...cli,
            ...more,
          },
          credential: { type: "static", value: TOKEN },
        },
        new Date(),
      );
    return { t, vault, run };
  }

  it("refuses a CLI with neither credential hosts nor a choice, naming both fixes", () => {
    const { run } = connect({});
    expect(() => run({})).toThrow(ConnectError);
    expect(() => run({})).toThrow(/--credential-host <host>.*--credential-delivery env/);
  });

  it("stores credential hosts, bearer by default", () => {
    const { t, run } = connect({ credentialHosts: ["app.terraform.io"] });
    run({});
    expect(findAccount(t.db, t.orgId, "tool")?.settings).toMatchObject({
      credentialEnv: "TF_TOKEN",
      credentialHosts: ["app.terraform.io"],
      credentialAuth: "bearer",
      credentialDelivery: "proxy",
    });
    expect(listAccounts(t.db, t.orgId)[0]?.credentialDelivery).toBe("proxy");
  });

  it("stores the escape hatch, and lists it as env", () => {
    const { t, run } = connect({ credentialDelivery: "env" });
    run({});
    expect(findAccount(t.db, t.orgId, "tool")?.settings).toMatchObject({
      credentialHosts: [],
      credentialDelivery: "env",
    });
    expect(listAccounts(t.db, t.orgId)[0]?.credentialDelivery).toBe("env");
  });

  it("connects npm with only its registry as credential host: no variable needed", () => {
    const { t, run } = connect({
      command: "npm",
      egress: ["registry.npmjs.org"],
      credentialEnv: null,
      credentialHosts: ["registry.npmjs.org"],
    });
    run({});
    expect(findAccount(t.db, t.orgId, "tool")?.settings).toMatchObject({
      command: "npm",
      credentialEnv: null,
      credentialHosts: ["registry.npmjs.org"],
      credentialAuth: "bearer",
    });
  });

  it.each<[string, Partial<NonNullable<ConnectInput["cli"]>>, RegExp]>([
    [
      "env delivery with credential hosts",
      { credentialDelivery: "env", credentialHosts: ["app.terraform.io"] },
      /leave out --credential-host/,
    ],
    ["proxy delivery with no hosts", { credentialDelivery: "proxy" }, /needs --credential-host/],
    [
      "a credential host outside the egress list",
      { credentialHosts: ["evil.example"] },
      /isn't one of the account's --egress hosts/,
    ],
    [
      "a variable the runner sets",
      { credentialEnv: "HTTPS_PROXY", credentialHosts: ["app.terraform.io"] },
      /a variable heel sets itself/,
    ],
    [
      "a variable that loads code",
      { credentialEnv: "NODE_OPTIONS", credentialDelivery: "env" },
      /a variable heel sets itself/,
    ],
    [
      "npm's config variable as the credential variable",
      {
        command: "npm",
        egress: ["registry.npmjs.org"],
        credentialEnv: "NPM_CONFIG_USERCONFIG",
        credentialHosts: ["registry.npmjs.org"],
      },
      /a variable heel sets itself/,
    ],
    [
      "npm with an auth it never sends",
      {
        command: "npm",
        egress: ["registry.npmjs.org"],
        credentialEnv: null,
        credentialHosts: ["registry.npmjs.org"],
        credentialAuth: "basic",
      },
      /bearer token/,
    ],
    [
      "npm with no credential host",
      { command: "npm", egress: ["registry.npmjs.org"], credentialEnv: null },
      /npm needs --credential-host/,
    ],
    [
      "credential hosts on gh, which has its own",
      { command: "gh", credentialEnv: null, credentialHosts: ["api.github.com"] },
      /gh's token always goes through heel's egress proxy/,
    ],
  ])("refuses %s", (_label, cli, message) => {
    const { run } = connect(cli);
    expect(() => run({})).toThrow(message);
  });

  it("heel account set moves a CLI to the proxy, or to env delivery, and refuses both at once", () => {
    const { t, vault, run } = connect({ credentialDelivery: "env" });
    run({});
    expect(
      configureAccount(t.db, vault, t.orgId, "tool", {
        credentialHosts: ["app.terraform.io"],
        credentialAuth: "header:X-Api-Key",
      }),
    ).toMatchObject({ credentialDelivery: "proxy", rotate: true });
    expect(findAccount(t.db, t.orgId, "tool")?.settings).toMatchObject({
      credentialHosts: ["app.terraform.io"],
      credentialAuth: "header:X-Api-Key",
      credentialDelivery: "proxy",
    });
    expect(() =>
      configureAccount(t.db, vault, t.orgId, "tool", {
        credentialHosts: ["app.terraform.io"],
        credentialAuth: null,
        credentialDelivery: "env",
      }),
    ).toThrow(/leave out --credential-host/);
    expect(
      configureAccount(t.db, vault, t.orgId, "tool", {
        credentialHosts: [],
        credentialAuth: null,
        credentialDelivery: "env",
      }),
    ).toMatchObject({ credentialDelivery: "env", rotate: false });
    expect(() =>
      configureAccount(t.db, vault, t.orgId, "tool", { credentialHosts: [], credentialAuth: null }),
    ).toThrow(/at least one --credential-host <host>, or --credential-delivery env/);
  });

  it("heel account set refuses an old account whose variable heel sets itself, at once rather than at run time", () => {
    const { t, vault, run } = connect({ credentialDelivery: "env" });
    run({});
    const id = findAccount(t.db, t.orgId, "tool")?.id ?? "";
    const settings = {
      ...findAccount(t.db, t.orgId, "tool")?.settings,
      credentialEnv: "NODE_AUTH_TOKEN",
    };
    t.db.update(accounts).set({ settings }).where(eq(accounts.id, id)).run();
    expect(() =>
      configureAccount(t.db, vault, t.orgId, "tool", {
        credentialHosts: ["app.terraform.io"],
        credentialAuth: null,
      }),
    ).toThrow(/NODE_AUTH_TOKEN is a variable heel sets itself/);
  });

  it("a hand-edited CLI row with no way to deliver its credential is refused before any rule", async () => {
    const h = cliPipeline({
      owner: allowAll("terraform"),
      settings: { ...LEGACY_CLI, credentialEnv: null },
      credential: TOKEN,
    });
    const answer = await h.run({ argv: ["terraform", "plan"], cwd: h.repo });
    expect(answer.body).toMatchObject({ status: "denied", reason: "credential_delivery" });
    expect(h.started).toEqual([]);
  });

  it("heel account set refuses gh, whose token is always at the proxy", () => {
    const { t, vault, run } = connect({ command: "gh", credentialEnv: null });
    run({});
    expect(() =>
      configureAccount(t.db, vault, t.orgId, "tool", {
        credentialHosts: ["api.github.com"],
        credentialAuth: null,
      }),
    ).toThrow(/nothing to set/);
  });
});
