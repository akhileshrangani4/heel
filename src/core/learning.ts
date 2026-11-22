import { createHash } from "node:crypto";
import type { Call } from "./call.ts";
import { domainOf, normalizeAddress } from "./rules/address.ts";
import { type CompiledRule, compileRulesFile, ruleContentHash } from "./rules/compile.ts";
import { evaluate, NO_STANDING_APPROVALS, plainMatch, type RuleSet } from "./rules/evaluate.ts";
import { factsOf } from "./rules/facts.ts";
import { RulesFile } from "./rules/schema.ts";

/**
 * Learning from what you approve (roadmap 2.10). heel groups the requests a
 * person decided in the last 30 days and, where they keep making the same
 * decision, drafts a rule that would make it for them. A suggestion is only
 * a draft: it becomes a proposal the person reads and adds with a passkey.
 * No model decides anything here. Pure.
 *
 * A suggested rule is never wider than its evidence:
 *
 * - It names the agent the requests came from, and the account and action.
 * - An allow names what the calls had in common that a rule can match: the
 *   repo, the calendar, or the recipients' domains. Calls with none of those
 *   aren't suggested as allows: "allow this action with any arguments" goes
 *   past what was approved. (A deny only takes away, so it needs none.)
 * - It matches no call the person decided the other way in the window.
 * - It isn't suggested when the rule that asked has a count or a state check
 *   (proposed rules go first in the file, so an allow there would skip that
 *   guard), when that rule has changed or gone, or for org asks.
 * - It needs `approvals` decisions on at least `days` different days (UTC),
 *   so a burst of asks in one sitting doesn't earn a rule.
 * - Requests your rules no longer ask about aren't suggested.
 */

export const LEARNING_WINDOW_DAYS = 30;
/** How many suggestions are shown at once: few, so each is read. */
export const MAX_LEARNED = 5;

export interface DecidedCall {
  agentName: string;
  decision: "approved" | "denied";
  at: Date;
  /** The normalized call, as the request stored it. */
  call: Call;
  /** The rule that asked, as it stands now; null when it changed, went, or was an org rule. */
  askedBy: CompiledRule | null;
}

export interface LearningThreshold {
  /** Decisions needed, at least 2. */
  decisions: number;
  /** Different days they must fall on, at least 1. */
  days: number;
}

export interface LearnedRule {
  /** Stable for the same agent and rule: what dismissing and proposing name. */
  key: string;
  agentId: string;
  agentName: string;
  decision: "allow" | "deny";
  /** The rule as heel would propose it. */
  rule: { match: Record<string, unknown>; then: "allow" | "deny" };
  /** How many decisions it rests on, and on how many days. */
  count: number;
  days: number;
  since: Date;
  /** The evidence, in words: "approved 6 times on 3 days since Nov 12, all to work.com". */
  evidence: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** A suggestion's key: the same agent and rule always give the same key. */
export function learnedKey(agentId: string, rule: Record<string, unknown>): string {
  return createHash("sha256")
    .update(`${agentId}\u0000${ruleContentHash(rule as Parameters<typeof ruleContentHash>[0])}`)
    .digest("hex")
    .slice(0, 24);
}

function recipientDomains(call: Call): string[] {
  const domains = new Set<string>();
  for (const recipient of call.recipients ?? []) {
    const address = normalizeAddress(recipient);
    if (address !== null) domains.add(domainOf(address));
  }
  return [...domains].sort();
}

interface Group {
  agentId: string;
  agentName: string;
  decision: "approved" | "denied";
  account: string;
  /** The action, or the tool when the call had none. */
  subject: string;
  byAction: boolean;
  repo: string | undefined;
  calendar: string | undefined;
  domains: Set<string>;
  calls: DecidedCall[];
  /** Some call couldn't be learned from (see the module comment). */
  blocked: boolean;
}

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function shortDate(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function draft(group: Group): LearnedRule["rule"] {
  const then = group.decision === "approved" ? "allow" : "deny";
  const match: Record<string, unknown> = { agent: group.agentName, account: group.account };
  match[group.byAction ? "action" : "tool"] = group.subject;
  if (group.repo !== undefined) match["repo"] = group.repo;
  if (group.calendar !== undefined) match["calendar"] = group.calendar;
  // A deny keeps to what was denied, too, but needs no shape to be safe.
  if (group.domains.size > 0) match["recipients"] = { all_domain_in: [...group.domains].sort() };
  // biome-ignore lint/suspicious/noThenProperty: `then` is the rules file's key.
  return { match, then };
}

function compiled(rule: LearnedRule["rule"]): CompiledRule | null {
  const parsed = RulesFile.safeParse({ rules: [rule] });
  if (!parsed.success) return null;
  const result = compileRulesFile(parsed.data, {
    file: "suggestion",
    layer: "owner",
    lineOf: () => 0,
  });
  return result.ok ? (result.file.rules[0] ?? null) : null;
}

/** What the person's rules decide about this call today, with no lookups or counts. */
function decidesToday(rules: RuleSet | null, owner: string, decided: DecidedCall): string {
  return evaluate(rules, {
    owner,
    facts: factsOf(decided.call, decided.agentName),
    mode: "enforce",
    state: () => "unavailable",
    counted: () => 0,
    standing: NO_STANDING_APPROVALS,
  }).verdict.decision;
}

/** What the decisions had in common, for the evidence line. */
function shapeOf(group: Group): string {
  if (group.domains.size > 0) return `, all to ${[...group.domains].sort().join(", ")}`;
  if (group.repo !== undefined) return `, all in ${group.repo}`;
  if (group.calendar !== undefined) return `, all on calendar ${group.calendar}`;
  return "";
}

function evidence(group: Group, count: number, days: number, since: Date): string {
  return `${group.decision} ${count} times on ${days} days since ${shortDate(since)}${shapeOf(group)}`;
}

/**
 * The rules worth suggesting to `owner` (a user name) from what they decided,
 * most decisions first, at most MAX_LEARNED. `skip` holds keys not to offer
 * again: dismissed, or already waiting as a proposal.
 */
export function learnRules(
  decided: readonly DecidedCall[],
  input: {
    owner: string;
    rules: RuleSet | null;
    threshold: LearningThreshold;
    now: Date;
    skip?: ReadonlySet<string>;
  },
): LearnedRule[] {
  const from = input.now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS;
  const recent = decided.filter((d) => d.at.getTime() >= from && d.at <= input.now);
  const groups = new Map<string, Group>();
  for (const d of recent) {
    const byAction = d.call.action !== undefined;
    const subject = d.call.action ?? d.call.tool;
    const key = [
      d.call.agentId,
      d.decision,
      d.call.account,
      byAction ? "a" : "t",
      subject,
      d.call.repo ?? "",
      d.call.calendar ?? "",
    ].join("\u0000");
    const group = groups.get(key) ?? {
      agentId: d.call.agentId,
      agentName: d.agentName,
      decision: d.decision,
      account: d.call.account,
      subject,
      byAction,
      repo: d.call.repo,
      calendar: d.call.calendar,
      domains: new Set<string>(),
      calls: [],
      blocked: false,
    };
    group.calls.push(d);
    for (const domain of recipientDomains(d.call)) group.domains.add(domain);
    // Recipients heel couldn't read leave the shape unknown.
    if ((d.call.recipients ?? []).some((r) => normalizeAddress(r) === null)) group.blocked = true;
    const asker = d.askedBy;
    if (asker === null || asker.items !== null || asker.stateChecks.length > 0) {
      group.blocked = true;
    }
    groups.set(key, group);
  }

  const learned: LearnedRule[] = [];
  for (const group of groups.values()) {
    if (group.blocked) continue;
    const count = group.calls.length;
    const days = new Set(group.calls.map((c) => dayOf(c.at))).size;
    if (count < input.threshold.decisions || days < input.threshold.days) continue;
    const shaped =
      group.repo !== undefined || group.calendar !== undefined || group.domains.size > 0;
    if (group.decision === "approved" && !shaped) continue;

    const rule = draft(group);
    const key = learnedKey(group.agentId, rule);
    if (input.skip?.has(key) === true) continue;
    const candidate = compiled(rule);
    if (candidate === null) continue;

    // Never wider than the evidence: no call decided the other way may match it.
    const opposite = group.decision === "approved" ? "denied" : "approved";
    const contradicted = recent.some(
      (d) =>
        d.decision === opposite && plainMatch(candidate, factsOf(d.call, d.agentName)) !== false,
    );
    if (contradicted) continue;

    // Only what the rules still ask about: a rule added since already decides it.
    const latest = group.calls.reduce((a, b) => (b.at > a.at ? b : a));
    if (decidesToday(input.rules, input.owner, latest) !== "ask") continue;

    const since = group.calls.reduce((a, b) => (b.at < a.at ? b : a)).at;
    learned.push({
      key,
      agentId: group.agentId,
      agentName: group.agentName,
      decision: rule.then,
      rule,
      count,
      days,
      since,
      evidence: evidence(group, count, days, since),
    });
  }
  return learned
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, MAX_LEARNED);
}

/** One kind of request an agent made, and how its owner decided it (2.10's `heel_history`). */
export interface HistoryGroup {
  account: string;
  action?: string;
  /** The tool, for a call no built-in definition names an action for. */
  tool?: string;
  repo?: string;
  calendar?: string;
  recipient_domains?: string[];
  approved: number;
  denied: number;
  /** Different days (UTC) the decisions fell on. */
  days: number;
  /** When the latest was decided, ISO 8601. */
  last_decided: string;
}

/** How many kinds of request `heel_history` lists, most decided first. */
export const MAX_HISTORY_GROUPS = 50;

/**
 * An agent's decided requests, grouped by account, action and what a rule can
 * match on: counts and shapes, never arguments, subjects or bodies. Pure.
 */
export function summarizeDecisions(decided: readonly DecidedCall[], now: Date): HistoryGroup[] {
  const from = now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS;
  const groups = new Map<
    string,
    { group: HistoryGroup; domains: Set<string>; days: Set<string>; last: Date }
  >();
  for (const d of decided) {
    if (d.at.getTime() < from || d.at > now) continue;
    const { call } = d;
    const key = [
      call.account,
      call.action ?? `tool:${call.tool}`,
      call.repo ?? "",
      call.calendar ?? "",
    ].join("\u0000");
    let entry = groups.get(key);
    if (entry === undefined) {
      const group: HistoryGroup = {
        account: call.account,
        ...(call.action === undefined ? { tool: call.tool } : { action: call.action }),
        ...(call.repo === undefined ? {} : { repo: call.repo }),
        ...(call.calendar === undefined ? {} : { calendar: call.calendar }),
        approved: 0,
        denied: 0,
        days: 0,
        last_decided: "",
      };
      entry = { group, domains: new Set(), days: new Set(), last: d.at };
      groups.set(key, entry);
    }
    if (d.decision === "approved") entry.group.approved += 1;
    else entry.group.denied += 1;
    entry.days.add(dayOf(d.at));
    if (d.at > entry.last) entry.last = d.at;
    for (const domain of recipientDomains(call)) entry.domains.add(domain);
  }
  return [...groups.values()]
    .map(({ group, domains, days, last }) => ({
      ...group,
      ...(domains.size === 0 ? {} : { recipient_domains: [...domains].sort() }),
      days: days.size,
      last_decided: last.toISOString(),
    }))
    .sort(
      (a, b) =>
        b.approved + b.denied - (a.approved + a.denied) ||
        b.last_decided.localeCompare(a.last_decided),
    )
    .slice(0, MAX_HISTORY_GROUPS);
}
