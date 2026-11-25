import { createHash } from "node:crypto";
import type { Call } from "./call.ts";
import { domainOf, normalizeAddress } from "./rules/address.ts";
import { type CompiledRule, compileRulesFile, ruleContentHash } from "./rules/compile.ts";
import { evaluate, NO_STANDING_APPROVALS, plainMatch, type RuleSet } from "./rules/evaluate.ts";
import { factsOf } from "./rules/facts.ts";
import { RulesFile } from "./rules/schema.ts";

/**
 * Learning from what you approve. heel groups the requests a
 * person decided in the last 30 days and, where they keep making the same
 * decision, drafts a rule that would make it for them. A suggestion is only
 * a draft: it becomes a proposal the person reads and adds with a passkey.
 * No model decides anything here. Pure.
 *
 * A suggested rule changes nothing but the requests it rests on:
 *
 * - It goes right before the rule that asked (`before`), with that rule's
 *   conditions as well as its own, so it only decides calls that rule would
 *   have asked about. Every rule above it still decides first.
 * - It names the agent, the account, the action and the tool, and exactly
 *   what the calls had in common that a rule can match: the repo, the
 *   calendar, and the exact set of recipients (or none at all). Calls with
 *   different recipients are different groups, so one approval can't widen
 *   another's, and a rule for mail to a and b doesn't cover mail to a alone.
 * - It says `persistence: false`, so it never matches a call that outlives
 *   heel (a filter that forwards mail, a workflow push, I-70) and doesn't
 *   count as naming one; groups with such a call aren't learned from at all.
 * - An allow needs a repo, a calendar or recipients: "allow this action with
 *   any arguments" goes past what was approved. A deny needs none.
 * - It matches no call the person decided the other way in the window.
 * - It isn't suggested when the rule that asked has a count or a state check,
 *   has changed or gone, or no longer asks about these calls; nor for org asks.
 * - It needs `decisions` decisions on at least `days` different days (UTC),
 *   so a burst of asks in one sitting doesn't earn a rule.
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
  /** Names this exact suggestion: what reviewing it takes. */
  key: string;
  /**
   * Names the kind of request (agent, decision, account, action, repo,
   * calendar), whatever the recipients: what dismissing hides, so a
   * dismissed suggestion doesn't come back as a near copy.
   */
  kindKey: string;
  agentId: string;
  agentName: string;
  decision: "allow" | "deny";
  /** The rule as heel would propose it, the asking rule's conditions included. */
  rule: { match: Record<string, unknown>; then: "allow" | "deny" };
  /**
   * Only what heel drew from the agent's own calls (agent, account, action,
   * tool, repo, calendar, recipients, persistence): what an agent may see.
   * The asking rule's conditions are the owner's, never shown to an agent.
   */
  own: Record<string, unknown>;
  /** The hash of the owner rule it goes right before: the one that asked. */
  before: string;
  /** How many decisions it rests on, and on how many days. */
  count: number;
  days: number;
  since: Date;
  /** The evidence, in words: "approved 6 times on 3 days since Nov 12, all to work.com". */
  evidence: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function hash(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 24);
}

/** A suggestion's key: the same agent and rule always give the same key. */
export function learnedKey(agentId: string, rule: Record<string, unknown>): string {
  return hash([agentId, ruleContentHash(rule as Parameters<typeof ruleContentHash>[0])]);
}

/** A suggested rule's kind key (see LearnedRule.kindKey), read back from the rule itself. */
export function kindKeyOf(
  agentId: string,
  rule: { match: Record<string, unknown>; then: string },
): string {
  const text = (key: string) => {
    const value = rule.match[key];
    return typeof value === "string" ? value : "";
  };
  return hash([
    agentId,
    rule.then,
    text("account"),
    text("action") === "" ? `tool:${text("tool")}` : text("action"),
    text("repo"),
    text("calendar"),
  ]);
}

type Recipients =
  | { kind: "absent" }
  | { kind: "unreadable" }
  | { kind: "none" }
  | { kind: "addresses"; values: string[] };

function recipientsOf(call: Call): Recipients {
  if (call.recipients === undefined) return { kind: "absent" };
  const addresses: string[] = [];
  for (const recipient of call.recipients) {
    const address = normalizeAddress(recipient);
    if (address === null) return { kind: "unreadable" };
    addresses.push(address);
  }
  if (addresses.length === 0) return { kind: "none" };
  return { kind: "addresses", values: [...new Set(addresses)].sort() };
}

function recipientsKey(r: Recipients): string {
  return "values" in r ? `${r.kind}:${r.values.join(",")}` : r.kind;
}

function recipientsCondition(r: Recipients): unknown {
  switch (r.kind) {
    case "none":
      // An absent field fails every check, so this matches only an empty list.
      return { max: 0 };
    case "addresses":
      // Exactly this set: not a subset of it, not a whole domain.
      return { equals: r.values };
    default:
      return undefined;
  }
}

interface Group {
  agentId: string;
  agentName: string;
  decision: "approved" | "denied";
  account: string;
  /** The action, or the tool when the call had none. */
  subject: string;
  byAction: boolean;
  tool: string;
  persistent: boolean;
  repo: string | undefined;
  calendar: string | undefined;
  recipients: Recipients;
  asker: CompiledRule | null;
  calls: DecidedCall[];
}

function dayOf(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function shortDate(at: Date): string {
  return at.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The asker's match with ours added: a call must pass both. Where both name
 * a key, ours is a literal value those calls had, which the asker's condition
 * on that key already accepted, so ours is the narrower one. Recipients
 * conditions combine when their operators don't overlap. Null when they
 * can't be combined.
 */
function combined(
  asker: Readonly<Record<string, unknown>>,
  ours: Record<string, unknown>,
): Record<string, unknown> | null {
  const match: Record<string, unknown> = { ...asker };
  for (const [key, value] of Object.entries(ours)) {
    const theirs = match[key];
    if (theirs === undefined || sameValue(theirs, value)) {
      match[key] = value;
    } else if (key !== "recipients" && typeof value === "string") {
      match[key] = value;
    } else if (
      key === "recipients" &&
      isObject(theirs) &&
      isObject(value) &&
      Object.keys(value).every((op) => !(op in theirs))
    ) {
      match[key] = { ...theirs, ...value };
    } else {
      return null;
    }
  }
  return match;
}

function ownFields(group: Group): Record<string, unknown> {
  const ours: Record<string, unknown> = { agent: group.agentName, account: group.account };
  if (group.byAction) ours["action"] = group.subject;
  ours["tool"] = group.tool;
  ours["persistence"] = false;
  if (group.repo !== undefined) ours["repo"] = group.repo;
  if (group.calendar !== undefined) ours["calendar"] = group.calendar;
  const recipients = recipientsCondition(group.recipients);
  if (recipients !== undefined) ours["recipients"] = recipients;
  return ours;
}

function draft(group: Group, asker: CompiledRule): LearnedRule["rule"] | null {
  const then = group.decision === "approved" ? "allow" : "deny";
  const match = combined(asker.match, ownFields(group));
  return match === null ? null : { match, then };
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

/** Whether the person's rules still ask about this call, by this rule (no lookups or counts). */
function stillAskedBy(
  rules: RuleSet | null,
  owner: string,
  decided: DecidedCall,
  asker: CompiledRule,
): boolean {
  const { verdict } = evaluate(rules, {
    owner,
    facts: factsOf(decided.call, decided.agentName),
    mode: "enforce",
    state: () => "unavailable",
    counted: () => 0,
    standing: NO_STANDING_APPROVALS,
  });
  return (
    verdict.decision === "ask" &&
    verdict.rule.hash === asker.hash &&
    verdict.rule.layer === "owner" &&
    !verdict.rule.watch
  );
}

/** What the decisions had in common, for the evidence line. */
function shapeOf(group: Group): string {
  const parts: string[] = [];
  if (group.repo !== undefined) parts.push(`in ${group.repo}`);
  if (group.calendar !== undefined) parts.push(`on calendar ${group.calendar}`);
  const r = group.recipients;
  if (r.kind === "none") parts.push("with no one invited or addressed");
  if (r.kind === "addresses") parts.push(`to ${r.values.join(", ")}`);
  return parts.length === 0 ? "" : `, all ${parts.join(", ")}`;
}

function evidence(group: Group, count: number, days: number, since: Date): string {
  return `${group.decision} ${count} times on ${days} ${days === 1 ? "day" : "days"} since ${shortDate(since)}${shapeOf(group)}`;
}

/**
 * The rules worth suggesting to `owner` (a user name) from what they decided,
 * most decisions first, at most `limit`. `skip` holds kind keys not to offer:
 * dismissed, or already waiting as a proposal.
 */
export function learnRules(
  decided: readonly DecidedCall[],
  input: {
    owner: string;
    rules: RuleSet | null;
    threshold: LearningThreshold;
    now: Date;
    skip?: ReadonlySet<string>;
    limit?: number;
    /** Only this agent's suggestions, so other agents' can't crowd them out of `limit`. */
    agentId?: string;
    /** Whether a live standing approval lets this agent's calls past this rule. */
    standing?: (agentId: string, ruleHash: string) => boolean;
  },
): LearnedRule[] {
  const from = input.now.getTime() - LEARNING_WINDOW_DAYS * DAY_MS;
  const recent = decided.filter((d) => d.at.getTime() >= from && d.at <= input.now);
  const groups = new Map<string, Group>();
  for (const d of recent) {
    const byAction = d.call.action !== undefined;
    const subject = d.call.action ?? d.call.tool;
    const recipients = recipientsOf(d.call);
    const key = [
      d.call.agentId,
      d.decision,
      d.call.account,
      byAction ? "a" : "t",
      subject,
      d.call.tool,
      d.call.persistence === true ? "p" : "",
      d.call.repo ?? "",
      d.call.calendar ?? "",
      recipientsKey(recipients),
      d.askedBy?.hash ?? "",
    ].join("\u0000");
    const group = groups.get(key) ?? {
      agentId: d.call.agentId,
      agentName: d.agentName,
      decision: d.decision,
      account: d.call.account,
      subject,
      byAction,
      tool: d.call.tool,
      persistent: d.call.persistence === true,
      repo: d.call.repo,
      calendar: d.call.calendar,
      recipients,
      asker: d.askedBy,
      calls: [],
    };
    group.calls.push(d);
    groups.set(key, group);
  }

  const learned: LearnedRule[] = [];
  for (const group of groups.values()) {
    if (input.agentId !== undefined && group.agentId !== input.agentId) continue;
    const { asker } = group;
    if (asker === null || asker.items !== null || asker.stateChecks.length > 0) continue;
    if (asker.layer !== "owner" || asker.watch) continue;
    if (group.recipients.kind === "unreadable" || group.persistent) continue;
    // A deny would stop calls a standing approval of the owner's lets through today.
    if (group.decision === "denied" && input.standing?.(group.agentId, asker.hash) === true) {
      continue;
    }
    const count = group.calls.length;
    const days = new Set(group.calls.map((c) => dayOf(c.at))).size;
    if (count < input.threshold.decisions || days < input.threshold.days) continue;
    const r = group.recipients.kind;
    const shaped = group.repo !== undefined || group.calendar !== undefined || r === "addresses";
    if (group.decision === "approved" && !shaped) continue;

    const rule = draft(group, asker);
    if (rule === null) continue;
    const kindKey = kindKeyOf(group.agentId, rule);
    if (input.skip?.has(kindKey) === true) continue;
    const candidate = compiled(rule);
    if (candidate === null) continue;

    // It matches every call it rests on, and none decided the other way.
    if (group.calls.some((d) => plainMatch(candidate, factsOf(d.call, d.agentName)) !== true)) {
      continue;
    }
    const opposite = group.decision === "approved" ? "denied" : "approved";
    const contradicted = recent.some(
      (d) =>
        d.decision === opposite && plainMatch(candidate, factsOf(d.call, d.agentName)) !== false,
    );
    if (contradicted) continue;

    // Only what that rule still asks about: a rule added or changed since decides it.
    const latest = group.calls.reduce((a, b) => (b.at > a.at ? b : a));
    if (!stillAskedBy(input.rules, input.owner, latest, asker)) continue;

    const since = group.calls.reduce((a, b) => (b.at < a.at ? b : a)).at;
    learned.push({
      key: learnedKey(group.agentId, rule),
      kindKey,
      agentId: group.agentId,
      agentName: group.agentName,
      decision: rule.then,
      rule,
      own: ownFields(group),
      before: asker.hash,
      count,
      days,
      since,
      evidence: evidence(group, count, days, since),
    });
  }
  return learned
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key))
    .slice(0, input.limit ?? MAX_LEARNED);
}

/** Every recipient domain a call had, sorted. */
function recipientDomains(call: Call): string[] {
  const domains = new Set<string>();
  for (const recipient of call.recipients ?? []) {
    const address = normalizeAddress(recipient);
    if (address !== null) domains.add(domainOf(address));
  }
  return [...domains].sort();
}

/** One kind of request an agent made, and how its owner decided it (`heel_history`). */
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
