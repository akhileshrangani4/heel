import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { LooksLikeJudge } from "../../src/core/hide.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { accounts } from "../../src/store/schema.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { FakeGraph, GRAPH_TEST_TOKEN, MAILBOX } from "./fake-graph.ts";
import { captureLogger } from "./log.ts";
import { compileRules } from "./pipeline.ts";
import { addAccount, testStore } from "./store.ts";

/**
 * The real pipeline with the real Outlook definition, in front of a fake
 * Graph mailbox. `call` sends one tool call on `outlook-work` as `inbox-bot`.
 */
export function outlookPipeline(options: { owner: string; org?: string; judge?: LooksLikeJudge }) {
  const t = testStore();
  const graph = new FakeGraph();
  const accountId = addAccount(t, "outlook-work", "outlook");
  t.db
    .update(accounts)
    .set({ settings: { mailbox: MAILBOX } })
    .where(eq(accounts.id, accountId))
    .run();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  vault.put(accountId, { type: "oauth", accessToken: GRAPH_TEST_TOKEN, refreshToken: "r" });
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: {
      set: compileRules({
        owner: options.owner,
        ...(options.org === undefined ? {} : { org: options.org }),
      }),
    },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      outlook: { vault, fetch: graph.fetch },
    }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
    ...(options.judge !== undefined && { looksLike: options.judge }),
  });
  const { agentId } = addAgent(
    t.db,
    { orgId: t.orgId, ownerId: t.ownerId, name: "inbox-bot" },
    new Date(),
  );
  const agent = {
    orgId: t.orgId,
    agentId,
    agentName: "inbox-bot",
    ownerId: t.ownerId,
    tokenId: "tok_1",
  };
  const call = (tool: string, args: Record<string, unknown> = {}) =>
    pipeline.run({ agent, surface: "mcp", account: "outlook-work", tool, args });
  return { t, graph, call };
}
