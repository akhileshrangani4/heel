import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { StartSandboxed } from "../../src/definitions/cli/definition.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent, setWorkRoots, workRootsOf } from "../../src/gateway/agents.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { handleRun } from "../../src/gateway/run-route.ts";
import type { SandboxHost, SandboxSpec } from "../../src/runner/plan.ts";
import type { SandboxOutcome } from "../../src/runner/run.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { accounts } from "../../src/store/schema.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { captureLogger } from "./log.ts";
import { compileRules } from "./pipeline.ts";
import { addAccount, testStore } from "./store.ts";

/** A low-entropy stand-in for a GitHub token. */
export const GH_TEST_TOKEN = "gh-test-token-not-real";

const FAKE_HOST: SandboxHost = {
  bwrap: "/usr/bin/bwrap",
  prlimit: "/usr/bin/prlimit",
  node: "/usr/bin/node",
  relay: "/heel/relay.ts",
  arch: "x86_64" as SandboxHost["arch"],
  systemDirs: [],
};

/**
 * The real pipeline and `/run` route with a `gh` CLI account, in front of a
 * fake sandbox that records each spec it's asked to start and answers with
 * `outcome` and `stdout`.
 */
export function cliPipeline(options: {
  owner: string;
  outcome?: SandboxOutcome;
  stdout?: string;
  sandbox?: boolean;
  /** A real sandbox host and runner, for the e2e suite; the fake one otherwise. */
  real?: { host: SandboxHost; start: StartSandboxed };
  /** The account's settings and credential, in place of `gh`'s. */
  settings?: Record<string, unknown>;
  credential?: string;
}) {
  const t = testStore();
  const command = String(options.settings?.["command"] ?? "gh");
  const accountId = addAccount(t, "github", `cli:${command}`);
  t.db
    .update(accounts)
    .set({
      settings: options.settings ?? {
        transport: "cli",
        command: "gh",
        bin: "/usr/bin/gh",
        egress: ["api.github.com", "github.com"],
        credentialEnv: null,
      },
    })
    .where(eq(accounts.id, accountId))
    .run();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  vault.put(accountId, { type: "static", value: options.credential ?? GH_TEST_TOKEN });
  const started: SandboxSpec[] = [];
  const fakeStart: StartSandboxed = async (_host, spec) => {
    started.push(spec);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    stdout.end(options.stdout ?? "");
    stderr.end("");
    return {
      stdin: null,
      stdout,
      stderr,
      done: Promise.resolve(options.outcome ?? { kind: "exited", code: 0 }),
      kill: () => {},
    };
  };
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner: options.owner }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      cli: {
        vault,
        sandbox: options.sandbox === false ? null : (options.real?.host ?? FAKE_HOST),
        start:
          options.real === undefined
            ? fakeStart
            : (host, spec, o) => {
                started.push(spec);
                return (options.real as { start: StartSandboxed }).start(host, spec, o);
              },
        workRoots: (agentId) => workRootsOf(t.db, agentId),
      },
    }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
  });
  const { agentId } = addAgent(
    t.db,
    { orgId: t.orgId, ownerId: t.ownerId, name: "coder" },
    new Date(),
  );
  const agent = {
    orgId: t.orgId,
    agentId,
    agentName: "coder",
    ownerId: t.ownerId,
    tokenId: "tok_1",
  };
  const root = realpathSync(mkdtempSync(join(tmpdir(), "heel-run-")));
  const repo = join(root, "repo");
  mkdirSync(repo);
  setWorkRoots(t.db, t.orgId, "coder", [root]);

  const app = new Hono();
  app.post("/run", (c) => handleRun(c, agent, { db: t.db, pipeline }));
  const run = async (body: Record<string, unknown>) => {
    const response = await app.request("/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return { t, agent, pipeline, started, root, repo, run };
}
