import { ACTION_PHRASES } from "./summary.ts";

/**
 * A proposed rule or hide entry in plain words, for the approval page:
 * "claude-code may open a GitHub issue on github without
 * asking you." Pure, and built from the rule heel will write, never from the
 * agent's why, so the sentence says what the rule does, not what the agent
 * says it does.
 *
 * Every match key ends up in the sentence. A key with no wording of its own
 * is spelled out as it is ("when args.force is true"), never dropped, so a
 * condition can't hide behind a friendly sentence. The YAML stays on the page
 * for anyone who wants it.
 */

type Condition = unknown;

/** `a`, `a or b`, `a, b or c`. */
function either(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} or ${items[items.length - 1]}`;
}

/** `a`, `a and b`, `a, b and c`. */
function both(items: readonly string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

function isOps(value: Condition): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  return Array.isArray(value) ? both(value.map(String)) : String(value);
}

/**
 * The values a text condition names, mapped through `name`, when it only
 * lists values (a scalar, equals, one_of or any_of). Null for anything else,
 * which the caller then spells out.
 */
function listed(condition: Condition, name: (value: string) => string): string | null {
  if (!isOps(condition)) return name(String(condition));
  const keys = Object.keys(condition);
  if (keys.length !== 1) return null;
  const [op] = keys;
  const value = condition[op as string];
  if (op === "equals" && !Array.isArray(value)) return name(String(value));
  if ((op === "one_of" || op === "any_of") && Array.isArray(value)) {
    return either(value.map((v) => name(String(v))));
  }
  return null;
}

/** Any condition as words after its key: `is x`, `is one of a or b`, `matches /re/`. */
function spelled(condition: Condition): string {
  if (!isOps(condition)) return `is ${String(condition)}`;
  const parts = Object.entries(condition).map(([op, value]) => {
    switch (op) {
      case "equals":
        return `is ${show(value)}`;
      case "one_of":
        return `is ${either((value as unknown[]).map(String))}`;
      case "any_of":
        return `includes ${either((value as unknown[]).map(String))}`;
      case "matches":
        return `matches /${String(value)}/`;
      case "max":
        return `is at most ${String(value)}`;
      case "any_domain_in":
        return `has an address at ${either((value as unknown[]).map(String))}`;
      case "all_domain_in":
        return `is all at ${either((value as unknown[]).map(String))}`;
      default:
        return `${op} ${show(value)}`;
    }
  });
  return both(parts);
}

/** Reads by service, for actions the summaries have no phrase for. */
const READS: Readonly<Record<string, string>> = {
  "github.read": "read GitHub",
  "calendar.read": "read calendars",
  "linear.read": "read Linear",
  "notion.read": "read Notion",
  "slack.read": "read Slack",
  "stripe.read": "read Stripe",
  "email.read": "read email",
};

function actionWords(action: string): string {
  return ACTION_PHRASES[action] ?? READS[action] ?? `do ${action}`;
}

/** What the rule lets or stops the agent do, and which keys that used up. */
function doing(match: Record<string, Condition>): { what: string; used: string[] } {
  if (match["action"] !== undefined) {
    const words = listed(match["action"], actionWords);
    // A tool named alongside it narrows it to that one: "(with get issue)", not "when tool is get_issue".
    const tool =
      match["tool"] === undefined
        ? null
        : listed(match["tool"], (t) => t.replace(/[_-]+/g, " ").trim());
    if (words !== null && tool !== null)
      return { what: `${words} (with ${tool})`, used: ["action", "tool"] };
    return {
      what: words ?? `do anything whose action ${spelled(match["action"])}`,
      used: ["action"],
    };
  }
  if (match["kind"] !== undefined) {
    const words = listed(match["kind"], (k) => (k === "read" ? "read anything" : "make changes"));
    if (words !== null) return { what: words, used: ["kind"] };
  }
  if (match["command"] !== undefined) {
    const command = listed(match["command"], (c) => c);
    const sub = match["subcommand"] === undefined ? "" : listed(match["subcommand"], (s) => s);
    if (command !== null && sub !== null) {
      return {
        what: `run ${command}${sub === "" ? "" : ` ${sub}`}`,
        used: sub === "" ? ["command"] : ["command", "subcommand"],
      };
    }
  }
  if (match["tool"] !== undefined) {
    const tool = listed(match["tool"], (t) => t.replace(/[_-]+/g, " ").trim());
    if (tool !== null) return { what: `use ${tool}`, used: ["tool"] };
  }
  return { what: "do anything", used: [] };
}

/** Where: one account, any account of a service, or any account. */
function where(match: Record<string, Condition>): { text: string; used: string[] } {
  if (match["account"] !== undefined) {
    const account = listed(match["account"], (a) => a);
    if (account !== null) return { text: ` on ${account}`, used: ["account"] };
  }
  if (match["provider"] !== undefined) {
    const provider = listed(match["provider"], (p) => p);
    if (provider !== null)
      return { text: ` on any of your ${provider} accounts`, used: ["provider"] };
  }
  return { text: match["account"] === undefined ? " on any of your accounts" : "", used: [] };
}

/**
 * A clause after the action: a phrase that reads on its own ("in acme/web"),
 * or a condition gathered after one "when" ("anyone it goes to is at x.com").
 */
type Clause = { pre: string } | { when: string };

/** Recipients, which have the most ways to be written. */
function recipients(condition: Condition): Clause[] {
  const plain = listed(condition, (a) => a);
  if (plain !== null) return [{ pre: `to ${plain}` }];
  if (!isOps(condition)) return [{ when: `recipients ${spelled(condition)}` }];
  return Object.entries(condition).map(([op, value]): Clause => {
    switch (op) {
      case "all_domain_in":
        return { pre: `only to people at ${either((value as unknown[]).map(String))}` };
      case "any_domain_in":
        return { when: `anyone it goes to is at ${either((value as unknown[]).map(String))}` };
      case "max":
        if (value === 0) return { pre: "with no one invited or addressed" };
        return { pre: `to at most ${String(value)} ${value === 1 ? "person" : "people"}` };
      case "equals":
        if (Array.isArray(value) && value.length === 0) {
          return { pre: "with no one invited or addressed" };
        }
        if (Array.isArray(value)) {
          const all = value.map(String);
          const last = all.pop();
          return {
            pre: `only to exactly ${all.length === 0 ? last : `${all.join(", ")} and ${last}`}`,
          };
        }
        return { when: `recipients ${spelled({ [op]: value })}` };
      case "all_in_thread":
        return { pre: "only to people already on the thread" };
      default:
        return { when: `recipients ${spelled({ [op]: value })}` };
    }
  });
}

/** The clauses for one remaining key: worded where heel knows the key, spelled out where it doesn't. */
function clauses(key: string, condition: Condition): Clause[] {
  const spelledOut: Clause = { when: `${key} ${spelled(condition)}` };
  const named = (prefix: string): Clause => {
    const value = listed(condition, (v) => v);
    return value === null ? spelledOut : { pre: `${prefix} ${value}` };
  };
  switch (key) {
    case "agent":
      return [{ when: `the agent ${spelled(condition)}` }];
    case "recipients":
      return recipients(condition);
    case "repo":
      return [named("in")];
    case "calendar":
      return [named("in calendar")];
    case "channel":
      return [named("in Slack channel")];
    case "team":
      return [named("for Linear team")];
    case "project":
      return [named("in Linear project")];
    case "parent":
      return [named("under Notion page")];
    case "customer":
      return [named("for Stripe customer")];
    case "currency":
      return [named("in")];
    case "kind":
      return [listed(condition, (k) => k) === "read" ? { pre: "(reads only)" } : spelledOut];
    case "checks":
      return [{ pre: "once the pull request's required checks pass" }];
    case "persistence": {
      const value = isOps(condition) ? condition["equals"] : condition;
      if (value === false)
        return [
          { pre: "(leaving out anything that keeps acting on its own, like a forwarding filter)" },
        ];
      if (value === true)
        return [{ pre: "(only what keeps acting on its own, like a forwarding filter)" }];
      return [spelledOut];
    }
    case "external": {
      const value = isOps(condition) ? condition["equals"] : condition;
      if (value === true) return [{ pre: "in channels shared with people outside your workspace" }];
      if (value === false) return [{ pre: "only in channels inside your workspace" }];
      return [spelledOut];
    }
    case "amount":
      if (isOps(condition) && Object.keys(condition).length === 1 && "max" in condition) {
        return [{ pre: `of at most ${String(condition["max"])}` }];
      }
      return [{ when: `the amount ${spelled(condition)}` }];
    case "items": {
      const items = condition as { over?: unknown; per?: unknown };
      const span =
        items.per === "hour"
          ? " in an hour"
          : items.per === "run"
            ? " in one script"
            : " in one call";
      return [{ when: `that's more than ${String(items.over)}${span}` }];
    }
    default:
      return [spelledOut];
  }
}

/** "any of your agents" starts a sentence capitalized; an agent's own name stays as it is. */
function capital(who: string): string {
  return who === "any of your agents" ? "Any of your agents" : who;
}

/** Pure: one rule as a sentence an owner reads before adding it. */
export function ruleInWords(rule: Record<string, unknown>): string {
  const match = (isOps(rule["match"]) ? rule["match"] : {}) as Record<string, Condition>;
  const used = new Set<string>();
  const agent = match["agent"] === undefined ? null : listed(match["agent"], (a) => a);
  if (agent !== null) used.add("agent");
  const who = agent ?? "any of your agents";
  const action = doing(match);
  for (const key of action.used) used.add(key);
  const place = where(match);
  for (const key of place.used) used.add(key);
  const rest = Object.keys(match)
    .filter((key) => !used.has(key))
    .flatMap((key) => clauses(key, match[key]));
  const pre = rest.flatMap((c) => ("pre" in c ? [c.pre] : []));
  const when = rest.flatMap((c) => ("when" in c ? [c.when] : []));
  const body =
    `${action.what}${place.text}` +
    (pre.length === 0 ? "" : ` ${pre.join(" ")}`) +
    (when.length === 0 ? "" : ` when ${both(when)}`);
  const watch =
    rule["watch"] === true ? " (watch only: heel logs it and decides as if it weren't there)" : "";
  switch (rule["then"]) {
    case "allow":
      return `${capital(who)} may ${body}${rest.length === 0 ? "" : ","} without asking you.${watch}`;
    case "deny":
      return `${capital(who)} can't ${body}: heel refuses it.${watch}`;
    default:
      return `heel asks you before ${who} can ${body}.${watch}`;
  }
}

const LOOKS_LIKE_WORDS: Readonly<Record<string, string>> = {
  password_reset: "a password reset",
  login_code: "a login code",
};

/** Pure: one hide entry as a sentence. Hiding only ever takes email away from agents. */
export function hideInWords(entry: Record<string, unknown>): string {
  const email = (isOps(entry["email"]) ? entry["email"] : {}) as Record<string, Condition>;
  const parts = Object.entries(email).map(([key, condition]) => {
    switch (key) {
      case "from": {
        const plain = listed(condition, (a) => a);
        if (plain !== null) return `from ${plain}`;
        if (isOps(condition) && Array.isArray(condition["any_domain_in"])) {
          return `from anyone at ${either(condition["any_domain_in"].map(String))}`;
        }
        return `when the sender ${spelled(condition)}`;
      }
      case "to": {
        const plain = listed(condition, (a) => a);
        return plain === null ? `when the recipients ${spelled(condition)}` : `sent to ${plain}`;
      }
      case "subject":
        return `whose subject ${spelled(condition)}`;
      case "labels": {
        const plain = listed(condition, (l) => l);
        return plain === null ? `when labels ${spelled(condition)}` : `labelled ${plain}`;
      }
      case "looks_like": {
        const kinds = (Array.isArray(condition) ? condition : [condition]).map(
          (k) => LOOKS_LIKE_WORDS[String(k)] ?? String(k),
        );
        return `that looks like ${either(kinds)}`;
      }
      default:
        return `when ${key} ${spelled(condition)}`;
    }
  });
  return `Hide email ${both(parts)} from every agent.`;
}
