import {
  type CallToolResult,
  ProtocolError,
  ProtocolErrorCode,
  type Tool,
} from "@modelcontextprotocol/server";
import { and, eq, gt } from "drizzle-orm";
import type { BackgroundRunner } from "../../codemode/background.ts";
import { LEARNING_WINDOW_DAYS } from "../../core/learning.ts";
import { ProposeRulesInput, pendingProposals, proposeRules } from "../../proposals/rules.ts";
import {
  pendingRequests,
  RequestConnectionInput,
  requestConnection,
} from "../../requests/connection.ts";
import { approvalStatusForAgent } from "../../store/approvals.ts";
import { historyFor, proposeSuggestion } from "../../store/learning.ts";
import { SqlitePauseStore } from "../../store/pauses.ts";
import { agentRequests, ruleProposals } from "../../store/schema.ts";
import { accountsUsableBy } from "../../store/sharing.ts";
import { isMcpProvider } from "../../vault/connect.ts";
import type { AuthenticatedAgent } from "../agent-tokens.ts";
import { agentStillLive } from "../agent-tokens.ts";
import { CONNECTED_NOTE_MS, connectedKeyNote } from "./connected.ts";
import {
  HEEL_ACCOUNTS_TOOL,
  HEEL_HISTORY_TOOL,
  HEEL_PROPOSE_RULES_TOOL,
  HEEL_REQUEST_CONNECTION_TOOL,
  HEEL_STATUS_TOOL,
} from "./names.ts";
import type { McpSurfaceDeps } from "./server.ts";
import {
  ACCOUNTS_CHANGED,
  type AccountsWait,
  type Held,
  NOTHING_WAITING,
  nothingChanged,
} from "./wait.ts";

/**
 * heel's own tools, listed last on every MCP scope. heel answers them
 * itself: an account tool by one of these names is never listed or called.
 */

/** One of heel's own tools: how it's listed, and what a call to it answers. */
export interface HeelTool {
  tool: Tool;
  call(
    agent: AuthenticatedAgent,
    args: Record<string, unknown>,
    held: Held,
  ): CallToolResult | Promise<CallToolResult>;
}

/** What heel's own tools use of the surface they're served on. */
export interface HeelToolsContext {
  deps: McpSurfaceDeps;
  now: () => Date;
  /** For `heel_status` on a background script. */
  background: BackgroundRunner | null;
  /** The surface's hold, which `heel_accounts` waits with; true once decided. */
  hold: (held: Held, decided: () => boolean) => Promise<boolean>;
  /** Whether `hold` would hold this call. */
  canHold: (held: Held) => boolean;
}

/** heel's own tools by name, in the order every scope lists them. */
export function heelTools({
  deps,
  now,
  background,
  hold,
  canHold,
}: HeelToolsContext): ReadonlyMap<string, HeelTool> {
  const pauses = deps.pauses ?? new SqlitePauseStore();

  /** The agent's own decided requests and heel's suggestions for it. */
  function heelHistory(agent: AuthenticatedAgent): CallToolResult {
    const { decisions, suggestions } = historyFor(
      {
        db: deps.db,
        rules: deps.learning?.rules.set ?? null,
        threshold: deps.learning?.threshold ?? null,
      },
      agent,
      now(),
    );
    const body = {
      window_days: LEARNING_WINDOW_DAYS,
      decisions,
      suggestions: suggestions.map((s) => ({
        suggestion: s.key,
        // Only what heel drew from this agent's own calls: the conditions heel adds from the
        // owner's rule that asked stay with heel, as the owner's file always does.
        decision: s.decision,
        match: s.own,
        evidence: s.evidence,
      })),
      message:
        suggestions.length === 0
          ? "No rule to suggest yet. Propose one with heel_propose_rules only if your owner keeps approving the same kind of call."
          : 'To ask for a suggested rule, call heel_propose_rules with {"suggestion": "<its suggestion id>"}. heel writes the rule, adds the conditions of your owner\'s rule that asked, and places it before that rule; nothing changes until your owner adds it with a passkey.',
    };
    return { content: [{ type: "text", text: JSON.stringify(body) }], structuredContent: body };
  }

  /**
   * An agent asks for one of heel's suggestions for it by id: heel
   * drafts the rule again from the owner's decisions and places it right
   * before the rule that asked, exactly as the owner's own Review would.
   */
  function proposeSuggestionTool(
    agent: AuthenticatedAgent,
    args: Record<string, unknown>,
    refuse: (body: Record<string, unknown>) => CallToolResult,
  ): CallToolResult {
    const key = args["suggestion"];
    if (typeof key !== "string" || Object.keys(args).length !== 1) {
      return refuse({
        status: "invalid",
        problems: ["suggestion: send only the id of a rule heel_history suggests, as a string"],
      });
    }
    const learning = {
      db: deps.db,
      rules: deps.learning?.rules.set ?? null,
      threshold: deps.learning?.threshold ?? null,
    };
    const outcome = proposeSuggestion(
      learning,
      { orgId: agent.orgId, userId: agent.ownerId },
      key,
      now(),
      agent.agentId,
    );
    if (outcome === null) {
      return refuse({
        status: "invalid",
        problems: ["suggestion: heel_history doesn't suggest that for you now"],
      });
    }
    if (!outcome.ok) return refuse({ status: "invalid", problems: outcome.problems });
    deps.log.info(
      { agent: agent.agentName, proposal: outcome.proposalId },
      "suggested rule proposed",
    );
    deps.onRuleProposal?.(outcome.proposalId);
    const answer = {
      status: "proposed",
      proposalId: outcome.proposalId,
      expiresAt: outcome.expiresAt.toISOString(),
      message:
        "Your owner will see heel's suggested rule on heel's approval page and can add it with a passkey. " +
        "Nothing changes until then.",
    };
    return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
  }

  /** Stores a rule proposal for the agent's owner; the target file is never the agent's choice. */
  function proposeRulesTool(
    agent: AuthenticatedAgent,
    args: Record<string, unknown>,
  ): CallToolResult {
    const refuse = (body: Record<string, unknown>): CallToolResult => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
    });
    const paused = pauses.find(deps.db, {
      orgId: agent.orgId,
      agentId: agent.agentId,
      ownerId: agent.ownerId,
      account: "",
      provider: "",
    });
    if (paused !== null) return refuse({ status: "paused", scope: paused });
    if ("suggestion" in args) return proposeSuggestionTool(agent, args, refuse);
    const input = ProposeRulesInput.safeParse(args);
    if (!input.success) {
      return refuse({
        status: "invalid",
        problems: input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const outcome = proposeRules(
      deps.db,
      { orgId: agent.orgId, ownerId: agent.ownerId, agentId: agent.agentId },
      input.data,
      now(),
    );
    if (!outcome.ok) return refuse({ status: "invalid", problems: outcome.problems });
    deps.log.info({ agent: agent.agentName, proposal: outcome.proposalId }, "rules proposed");
    deps.onRuleProposal?.(outcome.proposalId);
    const answer = {
      status: "proposed",
      proposalId: outcome.proposalId,
      expiresAt: outcome.expiresAt.toISOString(),
      message:
        "Your owner will see this on heel's approval page and can add it with a passkey. " +
        "Nothing changes until then; calls it would allow are still decided as they are now.",
    };
    return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
  }

  /** Stores a connection request for the agent's owner; nothing is connected or contacted. */
  function requestConnectionTool(
    agent: AuthenticatedAgent,
    args: Record<string, unknown>,
  ): CallToolResult {
    const refuse = (body: Record<string, unknown>): CallToolResult => ({
      isError: true,
      content: [{ type: "text", text: JSON.stringify(body) }],
      structuredContent: body,
    });
    const paused = pauses.find(deps.db, {
      orgId: agent.orgId,
      agentId: agent.agentId,
      ownerId: agent.ownerId,
      account: "",
      provider: "",
    });
    if (paused !== null) return refuse({ status: "paused", scope: paused });
    const input = RequestConnectionInput.safeParse(args);
    if (!input.success) {
      return refuse({
        status: "invalid",
        problems: input.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    }
    const outcome = requestConnection(
      deps.db,
      { orgId: agent.orgId, ownerId: agent.ownerId, agentId: agent.agentId },
      input.data,
      now(),
    );
    if (!outcome.ok) return refuse({ status: "refused", problem: outcome.problem });
    deps.log.info({ agent: agent.agentName, request: outcome.requestId }, "connection requested");
    deps.onAgentRequest?.(outcome.requestId);
    const answer = {
      status: "requested",
      requestId: outcome.requestId,
      expiresAt: outcome.expiresAt.toISOString(),
      message:
        "Your owner will see this on heel's approval page and can connect it with a passkey. " +
        "Nothing is connected until then. Once it is, the account's tools appear and your owner's rules decide what you can do.",
    };
    return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
  }

  /** The ids of what this agent asked for that still waits for its owner, as one string. */
  function waitingKey(agent: AuthenticatedAgent): string {
    // Read-only and narrow, as it runs every poll; marking rows expired is left to heelAccounts.
    const at = now();
    const requests = deps.db
      .select({ id: agentRequests.id })
      .from(agentRequests)
      .where(
        and(
          eq(agentRequests.agentId, agent.agentId),
          eq(agentRequests.status, "pending"),
          gt(agentRequests.expiresAt, at),
        ),
      )
      .all();
    const proposals = deps.db
      .select({ id: ruleProposals.id })
      .from(ruleProposals)
      .where(
        and(
          eq(ruleProposals.agentId, agent.agentId),
          eq(ruleProposals.origin, "agent"),
          eq(ruleProposals.status, "pending"),
          gt(ruleProposals.expiresAt, at),
        ),
      )
      .all();
    return [...requests, ...proposals]
      .map((row) => row.id)
      .sort()
      .join(",");
  }

  /**
   * What a held `heel_accounts` watches: what the agent asked for that still
   * waits, and each account it can use with its status. An account its owner
   * connects another way (`heel connect` for a key, leaving the request open)
   * or reconnects changes it too.
   */
  function watched(agent: AuthenticatedAgent): { waiting: string; key: string } {
    const waiting = waitingKey(agent);
    const usable = accountsUsableBy(deps.db, agent.orgId, agent.ownerId)
      .map((a) => `${a.alias}:${a.status}`)
      .join(",");
    return { waiting, key: `${waiting};${usable}` };
  }

  /**
   * `heel_accounts` with `wait: true`: held until something this agent
   * asked for is decided or expires, or one of its accounts connects or
   * changes, so it learns of a connection or a rule without its person
   * telling it to look again. Nothing waiting answers at once. The answer's
   * `wait` says which happened, so a window that ends with nothing changed
   * can't be read as the owner's answer.
   */
  async function heelAccountsWaiting(
    agent: AuthenticatedAgent,
    args: Record<string, unknown>,
    held: Held,
  ): Promise<CallToolResult> {
    if (args["wait"] !== true) return heelAccounts(agent);
    const before = watched(agent);
    let wait = NOTHING_WAITING;
    if (before.waiting !== "") {
      const started = Date.now();
      const holding = canHold(held);
      const changed = await hold(held, () => watched(agent).key !== before.key);
      wait = changed ? ACCOUNTS_CHANGED : nothingChanged(holding ? Date.now() - started : null);
    }
    if (!agentStillLive(deps.db, agent, now())) {
      throw new ProtocolError(ProtocolErrorCode.InvalidRequest, "This agent is no longer active");
    }
    return heelAccounts(agent, wait);
  }

  /** The accounts this agent asked for that its owner connected in the last day. */
  function justConnected(agent: AuthenticatedAgent, at: Date): Set<string> {
    const rows = deps.db
      .select({ accountId: agentRequests.accountId })
      .from(agentRequests)
      .where(
        and(
          eq(agentRequests.agentId, agent.agentId),
          eq(agentRequests.status, "approved"),
          gt(agentRequests.decidedAt, new Date(at.getTime() - CONNECTED_NOTE_MS)),
        ),
      )
      .all();
    return new Set(rows.flatMap((row) => (row.accountId === null ? [] : [row.accountId])));
  }

  /** The agent's accounts and what it asked for that still waits. Names only. */
  function heelAccounts(agent: AuthenticatedAgent, wait?: AccountsWait): CallToolResult {
    const at = now();
    const asked = justConnected(agent, at);
    const answer = {
      // First, so the agent reads how the wait ended before the lists.
      ...(wait === undefined ? {} : { wait }),
      accounts: accountsUsableBy(deps.db, agent.orgId, agent.ownerId).map((a) => {
        // A key it asked for, now working: what the owner can do with other copies of it.
        const next =
          asked.has(a.id) && a.status === "active" ? connectedKeyNote(a.provider, a.alias) : null;
        return {
          alias: a.alias,
          // A remote MCP server's provider id carries heel's own key; the agent sees "mcp".
          service: isMcpProvider(a.provider) ? "mcp" : a.provider,
          status: a.status,
          ...(next === null ? {} : { next }),
        };
      }),
      waiting: {
        connections: pendingRequests(deps.db, agent.ownerId, at)
          .filter((r) => r.agentId === agent.agentId)
          .map((r) => ({
            alias: r.details.alias,
            service: r.details.provider,
            expiresAt: r.expiresAt.toISOString(),
          })),
        ruleProposals: pendingProposals(deps.db, agent.ownerId, at)
          // Only its own: heel's suggestions about it aren't the agent's to see.
          .filter((p) => p.agentId === agent.agentId && p.origin === "agent")
          .map((p) => ({ proposalId: p.id, expiresAt: p.expiresAt.toISOString() })),
      },
      ...(deps.approvalsUrl === undefined ? {} : { approveAt: deps.approvalsUrl }),
    };
    return { content: [{ type: "text", text: JSON.stringify(answer) }], structuredContent: answer };
  }

  function heelStatus(agent: AuthenticatedAgent, args: Record<string, unknown>): CallToolResult {
    if (typeof args["script_id"] === "string") {
      const view = background?.view(agent, args["script_id"]) ?? null;
      const answer = view ?? { scriptId: args["script_id"], status: "unknown" };
      return {
        ...(view === null && { isError: true }),
        content: [{ type: "text", text: JSON.stringify(answer) }],
        structuredContent: answer as Record<string, unknown>,
      };
    }
    const approvalId = typeof args["approval_id"] === "string" ? args["approval_id"] : "";
    const status = approvalStatusForAgent(deps.db, agent, approvalId, now());
    const answer = { approvalId, status: status ?? "unknown" };
    return {
      ...(status === null && { isError: true }),
      content: [{ type: "text", text: JSON.stringify(answer) }],
      structuredContent: answer,
    };
  }

  const tools: HeelTool[] = [
    { tool: HEEL_STATUS_TOOL, call: heelStatus },
    { tool: HEEL_ACCOUNTS_TOOL, call: heelAccountsWaiting },
    { tool: HEEL_HISTORY_TOOL, call: heelHistory },
    { tool: HEEL_PROPOSE_RULES_TOOL, call: proposeRulesTool },
    { tool: HEEL_REQUEST_CONNECTION_TOOL, call: requestConnectionTool },
  ];
  return new Map(tools.map((entry) => [entry.tool.name, entry]));
}
