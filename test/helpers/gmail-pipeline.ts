import { randomBytes } from "node:crypto";
import type { LooksLikeJudge } from "../../src/core/hide.ts";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { FakeGmail, GMAIL_TEST_TOKEN } from "./fake-gmail.ts";
import { captureLogger } from "./log.ts";
import { compileRules } from "./pipeline.ts";
import { addAccount, testStore } from "./store.ts";

/**
 * The real pipeline with the real Gmail definition, in front of a fake
 * mailbox. `owner` is the owner's rules file (YAML); `call` sends one tool
 * call on `gmail-work` as the agent `inbox-bot`.
 */
export function gmailPipeline(options: { owner: string; judge?: LooksLikeJudge }) {
  const t = testStore();
  const gmail = new FakeGmail();
  const accountId = addAccount(t, "gmail-work", "gmail");
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  vault.put(accountId, { type: "oauth", accessToken: GMAIL_TEST_TOKEN, refreshToken: "r" });
  const { logger } = captureLogger();
  const hidden: string[] = [];
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner: options.owner }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: { vault, fetch: gmail.fetch },
    }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
    onHidden: (reason) => hidden.push(reason),
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
    pipeline.run({ agent, surface: "mcp", account: "gmail-work", tool, args });
  return { t, gmail, call, hidden };
}
