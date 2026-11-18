import { parseHints } from "../core/hints.ts";
import type { Logger } from "../log.ts";
import { getApproval } from "../store/approvals.ts";
import type { HeelDb } from "../store/db.ts";
import { recentCalls, saveHints } from "../store/hints.ts";
import type { ApprovalAdapter } from "./pipeline/ports.ts";

/**
 * Runs the approval adapters for a request that just became pending, and
 * stores what each said (core/hints.ts). Called from the pipeline's
 * `onApprovalRequested`, beside notifications, and never awaited by it:
 * the agent already has its "pending" answer, and nothing here can change
 * the request. A failure is stored as "unavailable" and logged.
 */

export interface ApprovalHintDeps {
  db: HeelDb;
  orgId: string;
  adapters: readonly ApprovalAdapter[];
  log: Logger;
  now: () => Date;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function runApprovalHints(deps: ApprovalHintDeps, approvalId: string): Promise<void> {
  if (deps.adapters.length === 0) return;
  const record = getApproval(deps.db, deps.orgId, approvalId, deps.now());
  // A request decided or expired in the meantime needs no advice, and isn't sent anywhere.
  if (record === null || record.status !== "pending") return;
  const { call } = record.row;
  const input = {
    approvalId,
    call,
    agentName: record.agentName,
    recentCalls: recentCalls(deps.db, deps.orgId, call.agentId, approvalId),
  };
  await Promise.all(
    deps.adapters.map(async (adapter) => {
      const signal = AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      let result: ReturnType<typeof parseHints>;
      try {
        result = parseHints(await adapter.hints(input, signal));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        deps.log.warn({ adapter: adapter.name, approvalId, detail }, "approval hints unavailable");
        result = { status: "unavailable", detail };
      }
      saveHints(deps.db, approvalId, adapter.name, result, deps.now());
    }),
  );
}
