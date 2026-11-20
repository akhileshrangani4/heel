import { describeRule } from "../core/rules/cases.ts";
import { evaluate, NO_STANDING_APPROVALS, type RuleSet } from "../core/rules/evaluate.ts";
import type { ConnectionRequestDetails } from "../store/schema.ts";
import { mcpProvider } from "../vault/connect.ts";

/**
 * What the owner's rules would let the requesting agent do with a new
 * account, worked out by heel's real evaluation on two sample calls: a read
 * and anything else. Approving a connection loosens things (a rule that
 * names no account covers the new one at once), so the request page shows
 * this before the passkey. Pure.
 */

export type CoverageVerdict = "allow" | "ask" | "deny" | "depends";

export interface CoverageLine {
  /** "a read", "anything else", "a call" (an MCP server's tools have no kind). */
  call: string;
  verdict: CoverageVerdict;
  /** The rule that decides it, as `heel rules test` names one; null for the default deny. */
  rule: string | null;
}

export function coverage(
  set: RuleSet | null,
  owner: string,
  agent: string,
  details: ConnectionRequestDetails,
): CoverageLine[] {
  // An MCP passthrough account is stored under provider `mcp`, and its tools
  // are never read-only to heel, so one sample covers it.
  const samples: [string, "read" | "write" | undefined][] =
    details.provider === "mcp"
      ? [["a call", undefined]]
      : [
          ["a read", "read"],
          ["anything else", "write"],
        ];
  return samples.map(([call, kind]) => {
    const evaluation = evaluate(set, {
      owner,
      facts: {
        agent,
        account: details.alias,
        // An MCP account is stored, and matched by rules, as `mcp:<alias>`.
        provider: details.provider === "mcp" ? mcpProvider(details.alias) : details.provider,
        ...(kind === undefined ? {} : { kind }),
        items: 1,
      },
      mode: "enforce",
      // A rule that checks the account's state can't be judged ahead of time.
      state: () => "unavailable",
      counted: () => 0,
      standing: NO_STANDING_APPROVALS,
    });
    const { verdict } = evaluation;
    if (verdict.decision === "deny" && verdict.reason === "state_check_unavailable") {
      return {
        call,
        verdict: "depends",
        rule: verdict.rule === null ? null : describeRule(verdict.rule),
      };
    }
    return {
      call,
      verdict: verdict.decision,
      rule: verdict.rule === null ? null : describeRule(verdict.rule),
    };
  });
}
