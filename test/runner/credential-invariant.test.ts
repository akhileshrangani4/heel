/**
 * I-75, structurally: for `gh` and for a local MCP server with credential
 * hosts, the real definitions build a sandbox from a random token, and none
 * of what the sandbox would receive carries that token in any form: not its
 * environment, its files, its arguments, the bwrap options, or any fd heel
 * writes. Only the host side keeps it (the output scrub list, and the getter
 * heel's proxy calls).
 *
 * e2e/runner/credential-proxy.test.ts and e2e/runner/mcp-stdio.test.ts prove
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

  it("I-75: gh gets a placeholder; the token's bytes are nowhere in what the sandbox receives", async () => {
    const token = randomToken();
    const h = cliPipeline({
      owner: "rules:\n  - match: { command: gh }\n    then: allow\n",
      credential: token,
    });
    const answer = await h.run({ argv: ["gh", "pr", "list", "-R", "acme/web"], cwd: h.repo });
    expect(answer.body["status"]).toBe("ran");
    const [spec] = h.started;
    if (spec === undefined) throw new Error("nothing started");

    expect(leakedForms(sandboxReceives(spec), token)).toEqual([]);
    // The host side still has it: the proxy's getter, and the output scrub.
    const inject = spec.network?.kind === "egress" ? spec.network.inject : undefined;
    expect(await inject?.credential()).toBe(token);
    expect(spec.secrets).toContain(token);
  });

  it("I-75: a local MCP server with credential hosts gets a placeholder, through the real launcher and pool", async () => {
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
          credentialAuth: "bearer",
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
    expect(await inject?.credential()).toBe(token);
  });
});
