import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { mcpPassthrough } from "../../src/definitions/mcp/passthrough.ts";
import { type StdioUpstream, stdioSandboxSpec } from "../../src/definitions/mcp/settings.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { createLogger } from "../../src/log.ts";
import { probeSandbox, startSandboxed } from "../../src/runner/index.ts";
import type { AccountRecord } from "../../src/store/directory.ts";

/**
 * A local MCP server under real bubblewrap (D5b, spec: Upstream MCP servers,
 * N-8): heel starts it in the sandbox with its credential in one variable,
 * speaks MCP over its pipes, and scrubs the credential from results.
 */

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/mcp/stdio-server.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOKEN = "local-e2e-token";

const probe = await probeSandbox();
if (!probe.ok && process.env["HEEL_REQUIRE_SANDBOX"] === "1") {
  throw new Error(`HEEL_REQUIRE_SANDBOX is set but the sandbox is unavailable: ${probe.detail}`);
}

describe.skipIf(!probe.ok)("a local MCP server in the sandbox", () => {
  it("I-02: lists and calls its tools over stdio, with the credential delivered and scrubbed", async () => {
    if (!probe.ok) return;
    const host = probe.host;
    const workRoot = realpathSync(mkdtempSync(join(tmpdir(), "heel-e2e-mcp-")));
    onTestFinished(() => rmSync(workRoot, { recursive: true, force: true }));
    const upstream: StdioUpstream = {
      transport: "stdio",
      command: host.node,
      args: [FIXTURE],
      egress: [],
      credentialEnv: "NOTES_TOKEN",
      // The server's code and its dependencies, read-only; nothing else of the checkout.
      mounts: [dirname(FIXTURE), join(ROOT, "node_modules"), join(ROOT, "package.json")],
    };
    const account: AccountRecord = {
      id: "acc_e2e",
      orgId: "org_e2e",
      ownerId: "usr_e2e",
      ownerName: "owner",
      alias: "local-notes",
      provider: "mcp:local-notes",
      status: "active",
      settings: upstream,
    };
    const pool = new UpstreamPool({
      vault: null,
      // Info level: if the server fails in the sandbox, its stderr lands in the CI log.
      log: createLogger("info"),
      launchStdio: (_account, settings) =>
        startSandboxed(host, stdioSandboxSpec(settings, { workRoot, credential: TOKEN })),
    });
    onTestFinished(() => pool.close());
    const signal = AbortSignal.timeout(30_000);

    expect((await pool.listTools(account, signal)).map((tool) => tool.name)).toEqual([
      "echo",
      "token",
    ]);
    const echoed = await pool.callTool(account, "echo", { text: "from the sandbox" }, signal);
    expect(echoed).toMatchObject({ content: [{ text: "from the sandbox" }] });

    // The server received the credential; the runner's own output scrub redacts it on the way out.
    const result = await mcpPassthrough(account, pool).execute(
      {
        orgId: account.orgId,
        agentId: "agt_e2e",
        ownerId: account.ownerId,
        surface: "mcp",
        account: account.alias,
        provider: account.provider,
        tool: "token",
        args: {},
        items: 1,
      },
      signal,
    );
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).toContain("[redacted by heel]");
  });
});
