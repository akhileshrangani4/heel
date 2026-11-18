import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { UpstreamPool } from "../../src/definitions/mcp/upstream.ts";
import { definitionRegistry } from "../../src/definitions/registry.ts";
import { addAgent } from "../../src/gateway/agents.ts";
import { createPipeline } from "../../src/gateway/pipeline/pipeline.ts";
import { SqliteApprovalStore } from "../../src/store/approvals.ts";
import { SqlitePauseStore } from "../../src/store/pauses.ts";
import { accounts } from "../../src/store/schema.ts";
import { KEY_BYTES } from "../../src/vault/crypto.ts";
import { Vault } from "../../src/vault/vault.ts";
import { CALENDAR_TEST_TOKEN, FakeCalendar, OWNER_CALENDAR } from "./fake-calendar.ts";
import { captureLogger } from "./log.ts";
import { compileRules } from "./pipeline.ts";
import { addAccount, testStore } from "./store.ts";

/** The real pipeline with the Google Calendar definition, in front of a fake calendar. */
export function calendarPipeline(options: { owner: string }) {
  const t = testStore();
  const calendar = new FakeCalendar();
  const accountId = addAccount(t, "calendar", "google-calendar");
  t.db
    .update(accounts)
    .set({ settings: { mailbox: OWNER_CALENDAR } })
    .where(eq(accounts.id, accountId))
    .run();
  const vault = Vault.open(t.db, { bytes: randomBytes(KEY_BYTES), source: "test" });
  vault.put(accountId, { type: "oauth", accessToken: CALENDAR_TEST_TOKEN, refreshToken: "r" });
  const { logger } = captureLogger();
  const pipeline = createPipeline({
    db: t.db,
    rules: { set: compileRules({ owner: options.owner }) },
    definitions: definitionRegistry({
      upstream: new UpstreamPool({ vault: null, log: logger }),
      gmail: null,
      googleCalendar: { vault, fetch: calendar.fetch },
    }),
    pauses: new SqlitePauseStore(),
    approvals: new SqliteApprovalStore(),
    log: logger,
    alerts: { raise: () => {} },
    watch: false,
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
    pipeline.run({ agent, surface: "mcp", account: "calendar", tool, args });
  return { t, calendar, call };
}
