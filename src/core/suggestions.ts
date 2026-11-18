import { domainOf, normalizeAddress } from "./rules/address.ts";

/**
 * Rule suggestions from recorded traffic (A5; v1 design "Rule suggestions").
 * After shadow or record mode, heel groups the calls the rules would have
 * stopped by account and action (or tool, for a passthrough), and drafts an
 * owner rule for each group. A suggestion is only text: a person reads it,
 * edits it, and adds it to their rules file themselves. Pure.
 */

export interface StoppedCall {
  account: string;
  action: string | null;
  tool: string;
  args: unknown;
}

export interface Suggestion {
  account: string;
  /** The action, or the tool when the call had none. */
  subject: string;
  /** How many recorded calls it covers. */
  seen: number;
  /** For email.send: every recipient domain the recorded calls used. */
  domains: string[];
  /** A rule to paste into an owner rules file, as YAML. */
  yaml: string;
}

const RECIPIENT_KEYS = ["to", "cc", "bcc"] as const;

function recipientDomains(args: unknown): string[] {
  if (typeof args !== "object" || args === null) return [];
  const domains: string[] = [];
  for (const key of RECIPIENT_KEYS) {
    const value = (args as Record<string, unknown>)[key];
    for (const entry of Array.isArray(value) ? value : []) {
      const address = typeof entry === "string" ? normalizeAddress(entry) : null;
      if (address !== null) domains.push(domainOf(address));
    }
  }
  return domains;
}

function quote(value: string): string {
  return /^[A-Za-z0-9_.:/-]+$/.test(value) ? value : JSON.stringify(value);
}

/** Groups stopped calls into suggestions, most-seen first, at most `limit`. */
export function suggestRules(calls: readonly StoppedCall[], limit = 20): Suggestion[] {
  const groups = new Map<
    string,
    { account: string; subject: string; byAction: boolean; seen: number; domains: Set<string> }
  >();
  for (const call of calls) {
    const byAction = call.action !== null;
    const subject = call.action ?? call.tool;
    const key = `${call.account}\u0000${byAction ? "a" : "t"}\u0000${subject}`;
    const group = groups.get(key) ?? {
      account: call.account,
      subject,
      byAction,
      seen: 0,
      domains: new Set(),
    };
    group.seen += 1;
    if (subject === "email.send") for (const d of recipientDomains(call.args)) group.domains.add(d);
    groups.set(key, group);
  }
  return [...groups.values()]
    .sort((a, b) => b.seen - a.seen || a.subject.localeCompare(b.subject))
    .slice(0, limit)
    .map((g) => {
      const domains = [...g.domains].sort();
      const match = [
        `account: ${quote(g.account)}`,
        g.byAction ? `action: ${quote(g.subject)}` : `tool: ${quote(g.subject)}`,
        ...(domains.length > 0
          ? [`recipients: { all_domain_in: [${domains.map(quote).join(", ")}] }`]
          : []),
      ];
      return {
        account: g.account,
        subject: g.subject,
        seen: g.seen,
        domains,
        yaml: `- match: { ${match.join(", ")} }\n  then: ${g.subject === "email.send" ? "ask" : "allow"}  # seen ${g.seen} times`,
      };
    });
}
