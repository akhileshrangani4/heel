import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { getRequestListener } from "@hono/node-server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { describe, expect, it, onTestFinished } from "vitest";
import { decideApproval, SqliteApprovalStore } from "../../src/store/approvals.ts";
import { openStore } from "../../src/store/db.ts";
import { deliveriesFor, savePushSubscription } from "../../src/store/notifications.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { approvals, users } from "../../src/store/schema.ts";
import { MASTER_KEY_ENV } from "../../src/vault/key.ts";
import { fakeUpstream } from "../helpers/mcp.ts";
import { addAgentToken, adminOk, boot, configIn, newKey, urlOf } from "../helpers/serve.ts";
import { tempDir } from "../helpers/store.ts";

/**
 * The MCP agent plane in a real `heel serve`, over real HTTP: an agent's
 * MCP client, heel, and an upstream MCP server on its own port. This is the
 * wiring the in-process tests can't see: the pipeline built from config,
 * the rules file, the vault, notifications, and shutdown.
 */

/** The fake upstream on a real loopback port. */
async function upstreamServer() {
  const upstream = fakeUpstream();
  const server = createServer(getRequestListener((request) => upstream.fetch(request)));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  onTestFinished(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const { port } = server.address() as AddressInfo;
  return { ...upstream, url: `http://127.0.0.1:${port}/mcp` };
}

async function agentClient(url: string, token: string): Promise<Client> {
  const client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return client;
}

describe("heel serve: the MCP agent plane", () => {
  it("I-01: lists and calls an upstream's tools, asks and notifies; once heel stops, nothing reaches the upstream", async () => {
    const upstream = await upstreamServer();
    const home = tempDir("heel-mcp-");
    mkdirSync(join(home, "rules"));
    writeFileSync(
      join(home, "rules", "owner.yaml"),
      "rules:\n  - match: { tool: search_notes }\n    then: allow\n  - match: { tool: delete_note }\n    then: ask\n",
    );
    const config = configIn(home);
    const heel = await boot(config, { [MASTER_KEY_ENV]: newKey() });
    const token = await addAgentToken(config, "inbox-bot");
    await adminOk(config, {
      method: "account.connect",
      params: { provider: "mcp", alias: "notes", url: upstream.url },
    });
    // The owner turned on notifications on one device.
    const store = openStore(config.databasePath);
    onTestFinished(() => store.close());
    const owner = store.db.select().from(users).get();
    if (owner === undefined) throw new Error("no owner");
    savePushSubscription(store.db, {
      orgId: owner.orgId,
      userId: owner.id,
      endpoint: "https://push.example.com/send/phone-1",
      p256dh: "test-p256dh-key",
      auth: "test-auth-secret",
      now: new Date(),
    });

    const url = `${urlOf(heel.planes.agent)}/mcp/notes`;
    const client = await agentClient(url, token);

    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain("search_notes");

    const allowed = await client.callTool({ name: "search_notes", arguments: { query: "q3" } });
    expect(allowed.isError).toBeFalsy();
    expect(upstream.calls).toEqual([{ name: "search_notes", arguments: { query: "q3" } }]);

    // The call that asks is held open (2.12) until the owner decides, then answers with the result.
    const asked = client.callTool({ name: "delete_note", arguments: { id: "n1" } });
    let request = store.db.select().from(approvals).get();
    while (request === undefined) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      request = store.db.select().from(approvals).get();
    }
    expect(request.status).toBe("pending");
    expect(deliveriesFor(store.db, request.id)).toMatchObject([
      { channel: "web_push", target: "https://push.example.com/send/phone-1" },
    ]);
    decideApproval(store.db, new SqliteApprovalStore(), new SqlitePauseStore(), {
      approver: { orgId: owner.orgId, userId: owner.id, role: "admin" },
      approvalId: request.id,
      callHash: request.callHash,
      intent: "approve",
      standing: null,
      now: new Date(),
    });
    expect((await asked).isError).toBeFalsy();
    expect(upstream.calls).toHaveLength(2);

    await client.close();
    await heel.close();
    await expect(agentClient(url, token)).rejects.toThrow();
    expect(upstream.calls).toHaveLength(2);
  });
});
