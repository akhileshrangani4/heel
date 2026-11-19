/**
 * I-75, structurally: for `gh`, and for a local MCP server, another CLI or
 * npm with credential hosts, the real definitions build a sandbox from a
 * random token, and none
 * of what the sandbox would receive carries that token in any form: not its
 * environment, its files, its arguments, the bwrap options, or any fd heel
 * writes. Only the host side keeps it (the output scrub list, and the getter
 * heel's proxy calls).
 *
 * e2e/runner/credential-proxy.test.ts (gh and npm) and e2e/runner/mcp-stdio.test.ts prove
 * the same under real bubblewrap, red-team style.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { StartSandboxed } from "../../src/definitions/cli/definition.ts";
import { sandboxLauncher } from "../../src/definitions/mcp/launch.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import type { CredentialAuth } from "../../src/runner/intercept.ts";
import { planSandbox, type SandboxHost, type SandboxSpec } from "../../src/runner/plan.ts";
import { findAccount } from "../../src/store/directory.ts";
import { connectAccount } from "../../src/vault/connect.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { cliPipeline } from "../helpers/cli-pipeline.ts";
import { captureLogger } from "../helpers/log.ts";
import { testStore } from "../helpers/store.ts";
import { leakedForms, tokenForms } from "../helpers/token-forms.ts";

const HOST: SandboxHost = {
  bwrap: "/usr/bin/bwrap",
  prlimit: "/usr/bin/prlimit",
  node: "/opt/node/bin/node",
  relay: "/opt/heel/src/runner/relay.ts",
  arch: "x64",
  systemDirs: [],
};
const TRUST = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

/** A random 40-character token: no form of it turns up anywhere by chance. */
function randomToken(): string {
  return randomBytes(30).toString("base64url");
}

/** Everything bwrap and the program would get for `spec`; the host-side scrub list left out. */
function sandboxReceives(spec: SandboxSpec): string {
  const network = spec.network?.kind === "egress" ? spec.network : undefined;
  const plan = planSandbox(
    HOST,
    spec,
    new Uint8Array(8),
    network === undefined ? undefined : "/tmp/heel-egress/egress.sock",
    network?.inject === undefined ? undefined : TRUST,
  );
  return [
    JSON.stringify({
      binary: spec.binary,
      args: spec.args,
      env: spec.env,
      secretEnv: spec.secretEnv,
      files: spec.files?.map((file) => ({
        name: file.name,
        content: Buffer.from(file.content).toString("latin1"),
      })),
      network:
        network === undefined
          ? spec.network
          : { ...network, inject: { ...network.inject, credential: undefined } },
    }),
    ...plan.argv,
    ...plan.options,
    ...plan.fds.map((fd) => (fd.kind === "write" ? Buffer.from(fd.data).toString("latin1") : "")),
  ].join("\n");
}

describe("I-75: the credential never enters the sandbox", () => {
  it("token-forms finds a token in any of the encodings a program might use", () => {
    const token = randomToken();
    for (const form of tokenForms(token)) {
      expect(leakedForms(`prefix ${form} suffix`, token)).toContain(form);
    }
    expect(leakedForms(`x${Buffer.from(`ab${token}`).toString("base64")}`, token)).not.toEqual([]);
    expect(leakedForms(token.split("").reverse().join(""), token)).not.toEqual([]);
    expect(leakedForms("nothing here", token)).toEqual([]);
  });

  it("the check catches a spec that does leak the token, in each place it inspects", () => {
    const token = randomToken();
    const placeholder = "heel-placeholder-0123456789abcdef";
    const clean: SandboxSpec = {
      binary: "/usr/bin/gh",
      args: ["pr", "list"],
      workRoot: "/srv/agents/ci",
      cwd: "/srv/agents/ci",
      env: { GH_TOKEN: placeholder },
    };
    expect(leakedForms(sandboxReceives(clean), token)).toEqual([]);
    const leaks: SandboxSpec[] = [
      { ...clean, env: { GH_TOKEN: placeholder, X: Buffer.from(`ab${token}`).toString("base64") } },
      { ...clean, args: ["pr", "list", "--search", [...token].reverse().join("")] },
      { ...clean, files: [{ name: "x.json", content: `{"t":"${encodeURIComponent(token)}"}` }] },
      { ...clean, secretEnv: { OTHER: Buffer.from(token).toString("hex") } },
    ];
    for (const leak of leaks) expect(leakedForms(sandboxReceives(leak), token)).not.toEqual([]);
  });

  /** gh through the real `/run` route and definition, with a fake start that records the spec. */
  async function ghLeaves(argv: string[]): Promise<void> {
    const token = randomToken();
    const h = cliPipeline({
      owner: "rules:\n  - match: { command: gh }\n    then: allow\n",
      credential: token,
    });
    const answer = await h.run({ argv, cwd: h.repo });
    expect(answer.body["status"]).toBe("ran");
    const [spec] = h.started;
    if (spec === undefined) throw new Error("nothing started");

    expect(leakedForms(sandboxReceives(spec), token)).toEqual([]);
    // The host side still has it: the proxy's getter, and the output scrub.
    const inject = spec.network?.kind === "egress" ? spec.network.inject : undefined;
    expect(await inject?.credential()).toBe(token);
    expect(spec.secrets).toContain(token);
  }

  it("I-75: gh pr list gets a placeholder; the token's bytes are nowhere in what the sandbox receives", () =>
    ghLeaves(["gh", "pr", "list", "-R", "acme/web"]));
  it("I-75: gh api gets a placeholder; the token's bytes are nowhere in what the sandbox receives", () =>
    ghLeaves(["gh", "api", "/repos/acme/web/pulls"]));
  it("I-75: gh pr view --json gets a placeholder; the token's bytes are nowhere in what the sandbox receives", () =>
    ghLeaves(["gh", "pr", "view", "12", "-R", "acme/web", "--json", "title"]));

  /** Another CLI with credential hosts, through the real `/run` route and definition. */
  async function cliLeaves(settings: Record<string, unknown>, argv: string[]) {
    const token = randomToken();
    const h = cliPipeline({
      owner: `rules:\n  - match: { command: ${String(settings["command"])} }\n    then: allow\n`,
      settings,
      credential: token,
    });
    const answer = await h.run({ argv, cwd: h.repo });
    expect(answer.body["status"]).toBe("ran");
    const [spec] = h.started;
    if (spec === undefined) throw new Error("nothing started");
    expect(leakedForms(sandboxReceives(spec), token)).toEqual([]);
    const inject = spec.network?.kind === "egress" ? spec.network.inject : undefined;
    expect(inject?.hosts).toEqual(settings["credentialHosts"]);
    expect(await inject?.credential()).toBe(token);
    expect(spec.secrets).toContain(token);
    return { spec, placeholder: inject?.placeholder };
  }

  it("I-75: a generic CLI with credential hosts gets a placeholder in its variable, and nothing else", async () => {
    const { spec, placeholder } = await cliLeaves(
      {
        transport: "cli",
        command: "terraform",
        bin: "/usr/bin/terraform",
        egress: ["app.terraform.io", "releases.hashicorp.com"],
        credentialEnv: "TF_TOKEN",
        credentialHosts: ["app.terraform.io"],
        credentialAuth: "bearer",
        credentialDelivery: "proxy",
      },
      ["terraform", "plan"],
    );
    expect(spec.env?.["TF_TOKEN"]).toBe(placeholder);
    expect(spec.secretEnv).toBeUndefined();
  });

  it("I-75: npm gets the placeholder in the user config heel writes and its variable, never the token", async () => {
    const { spec, placeholder } = await cliLeaves(
      {
        transport: "cli",
        command: "npm",
        bin: "/usr/bin/npm",
        egress: ["registry.npmjs.org"],
        credentialEnv: "NPM_TOKEN",
        credentialHosts: ["registry.npmjs.org"],
        credentialAuth: "bearer",
        credentialDelivery: "proxy",
      },
      ["npm", "publish"],
    );
    expect(spec.env?.["NPM_TOKEN"]).toBe(placeholder);
    expect(String(spec.files?.[0]?.content)).toContain(
      `//registry.npmjs.org/:_authToken=${placeholder}`,
    );
    expect(spec.secretEnv).toBeUndefined();
  });

  /** A local MCP server through the real pool, vault and launcher, with a fake start that records the spec. */
  async function stdioLeaves(credentialAuth: string, auth: CredentialAuth): Promise<void> {
    const token = randomToken();
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
        stdio: {
          command: process.execPath,
          args: ["server.js"],
          egress: ["api.notes.example", "cdn.notes.example"],
          credentialEnv: "NOTES_TOKEN",
          credentialHosts: ["api.notes.example"],
          credentialAuth,
          mounts: [],
        },
        credential: { type: "static", value: token },
      },
      new Date(),
    );
    const account = findAccount(t.db, t.orgId, "notes");
    if (account === null) throw new Error("no account");
    expect(JSON.stringify(account.settings)).not.toContain(token);

    const started: SandboxSpec[] = [];
    // Records the spec, then exits at once: the MCP handshake fails, which is all this test needs.
    const start: StartSandboxed = async (_host, spec) => {
      started.push(spec);
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      stdout.end();
      stderr.end();
      return {
        stdin: new PassThrough(),
        stdout,
        stderr,
        done: Promise.resolve({ kind: "exited", code: 1 }),
        kill: () => {},
      };
    };
    const home = realpathSync(mkdtempSync(join(tmpdir(), "heel-i75-")));
    const { logger } = captureLogger();
    const pool = new UpstreamPool({
      vault,
      log: logger,
      launchStdio: sandboxLauncher({ host: HOST, home, start, log: logger }),
    });
    await expect(pool.listTools(account, AbortSignal.timeout(5_000))).rejects.toThrow();
    await pool.close();

    const [spec] = started;
    if (spec === undefined) throw new Error("nothing started");
    expect(spec.env?.["NOTES_TOKEN"]).toMatch(/^heel-placeholder-/);
    expect(leakedForms(sandboxReceives(spec), token)).toEqual([]);
    const inject = spec.network?.kind === "egress" ? spec.network.inject : undefined;
    expect(inject?.hosts).toEqual(["api.notes.example"]);
    expect(inject?.auth).toEqual(auth);
    expect(await inject?.credential()).toBe(token);
  }

  it("I-75: a local MCP server with bearer credential hosts gets a placeholder, through the real launcher and pool", () =>
    stdioLeaves("bearer", { type: "authorization", schemes: ["bearer"] }));
  it("I-75: a local MCP server with basic credential hosts gets a placeholder, through the real launcher and pool", () =>
    stdioLeaves("basic", { type: "authorization", schemes: ["basic"] }));
  it("I-75: a local MCP server with a header credential host gets a placeholder, through the real launcher and pool", () =>
    stdioLeaves("header:X-Notes-Key", { type: "header", name: "x-notes-key" }));
});
