import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { mcpPassthrough } from "../../src/definitions/mcp/passthrough.ts";
import { MAX_MESSAGE_BYTES } from "../../src/definitions/mcp/sandbox-transport.ts";
import { type StdioUpstream, stdioSandboxSpec } from "../../src/definitions/mcp/settings.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { UpstreamError } from "../../src/gateway/pipeline/ports.ts";
import { createLogger } from "../../src/log.ts";
import { probeSandbox, startSandboxed } from "../../src/runner/index.ts";
import type { AccountRecord } from "../../src/store/directory.ts";
import { headerOf, httpsUpstream } from "../../test/helpers/https-upstream.ts";
import { leakedForms } from "../../test/helpers/token-forms.ts";

/**
 * A local MCP server under real bubblewrap (D5b, spec: Upstream MCP servers,
 * N-8): heel starts it in the sandbox, speaks MCP over its pipes, and keeps
 * its credential out of what the agent gets back. With credential hosts the
 * server never holds the credential at all: heel's egress proxy adds it.
 */

const FIXTURE = fileURLToPath(new URL("../../test/fixtures/mcp/stdio-server.ts", import.meta.url));
const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const TOKEN = "local-e2e-token";

const probe = await probeSandbox();
if (!probe.ok && process.env["HEEL_REQUIRE_SANDBOX"] === "1") {
  throw new Error(`HEEL_REQUIRE_SANDBOX is set but the sandbox is unavailable: ${probe.detail}`);
}

function setUp(
  settings: Partial<StdioUpstream>,
  credential: string,
  runOptions: Parameters<typeof startSandboxed>[2] = {},
) {
  if (!probe.ok) throw new Error("no sandbox");
  const host = probe.host;
  const workRoot = realpathSync(mkdtempSync(join(tmpdir(), "heel-e2e-mcp-")));
  onTestFinished(() => rmSync(workRoot, { recursive: true, force: true }));
  const upstream: StdioUpstream = {
    transport: "stdio",
    command: host.node,
    args: [FIXTURE],
    egress: [],
    credentialEnv: "NOTES_TOKEN",
    credentialHosts: [],
    credentialAuth: null,
    // The cases without credential hosts chose env delivery; with hosts, the proxy wins.
    credentialDelivery: "env",
    // The server's code and its dependencies, read-only; nothing else of the checkout.
    mounts: [dirname(FIXTURE), join(ROOT, "node_modules"), join(ROOT, "package.json")],
    ...settings,
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
    launchStdio: async (_account, stdio) =>
      startSandboxed(
        host,
        await stdioSandboxSpec(stdio, { workRoot, credential: async () => credential }),
        runOptions,
      ),
  });
  onTestFinished(() => pool.close());
  return { pool, account, workRoot };
}

function text(result: CallToolResult): string {
  const [first] = result.content;
  return first?.type === "text" ? first.text : "";
}

describe.skipIf(!probe.ok)("a local MCP server in the sandbox", () => {
  it("I-02: lists and calls its tools over stdio, with the credential delivered and scrubbed", async () => {
    const { pool, account } = setUp({}, TOKEN);
    const signal = AbortSignal.timeout(30_000);

    expect((await pool.listTools(account, signal)).map((tool) => tool.name)).toEqual([
      "echo",
      "token",
      "big",
      "request",
      "sweep",
    ]);
    const echoed = await pool.callTool(account, "echo", { text: "from the sandbox" }, signal);
    expect(echoed).toMatchObject({ content: [{ text: "from the sandbox" }] });

    // Without credential hosts the server receives the credential; the output scrub redacts it.
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

    // A response larger than heel reads fails that call only; the server restarts for the next.
    await expect(
      pool.callTool(account, "big", { bytes: MAX_MESSAGE_BYTES + 1024 }, signal),
    ).rejects.toBeInstanceOf(UpstreamError);
    const after = await pool.callTool(account, "echo", { text: "after" }, signal);
    expect(after).toMatchObject({ content: [{ text: "after" }] });
  });

  it("I-75: with credential hosts, the server holds a placeholder and heel's proxy adds the token", async () => {
    const upstream = await httpsUpstream();
    onTestFinished(() => upstream.close());
    const target = `127.0.0.1:${upstream.port}`;
    const token = randomBytes(30).toString("base64url");
    const { pool, account } = setUp(
      { egress: [target], credentialHosts: [target], credentialAuth: "bearer" },
      token,
      { upstreamCa: [upstream.ca] },
    );
    const signal = AbortSignal.timeout(30_000);

    const held = text(await pool.callTool(account, "token", {}, signal));
    expect(held).toMatch(/^token: heel-placeholder-[0-9a-f]+$/);
    const placeholder = held.slice("token: ".length);

    // The server's own fetch, through HTTPS_PROXY and the sandbox's CA bundle.
    const before = upstream.seen.length;
    const answered = text(
      await pool.callTool(account, "request", { url: `https://${target}/notes` }, signal),
    );
    expect(answered).toMatch(/^200 /);
    expect(headerOf(upstream.seen[before]?.rawHeaders ?? [], "authorization")).toBe(
      `Bearer ${token}`,
    );
    // The upstream reflected the request; the proxy scrubbed the token from the reflection.
    expect(answered).toContain("[redacted by heel]");

    const swept = text(await pool.callTool(account, "sweep", {}, signal));
    expect(JSON.parse(swept)).toMatchObject({ env: { NOTES_TOKEN: placeholder } });
    for (const seen of [held, answered, swept]) expect(leakedForms(seen, token)).toEqual([]);
  });
});
