import type { Call, CliFields, HttpFields } from "../call.ts";

/**
 * What a rule can see of one call: the normalized Call minus what rules never
 * match on (org, owner and agent ids, targets), plus the agent's name. Count
 * events store these too, so a count condition can re-check them against
 * history (spec: Counts and state checks).
 */
export interface RuleFacts {
  /** The agent's name, as rules write it. */
  agent: string;
  account: string;
  provider?: string;
  tool?: string;
  args?: unknown;
  action?: string;
  kind?: "read" | "write";
  /** Addresses as the definition derived them; normalized again before any check. */
  recipients?: readonly string[];
  repo?: string;
  cli?: CliFields;
  http?: HttpFields;
  /** Expanded item count; 1 when unknown. */
  items: number;
  runId?: string;
  /** The call creates something that outlives revocation (I-70). */
  persistence?: boolean;
}

export function factsOf(call: Call, agentName: string): RuleFacts {
  return {
    agent: agentName,
    account: call.account,
    provider: call.provider,
    tool: call.tool,
    args: call.args,
    items: call.items,
    ...(call.action !== undefined && { action: call.action }),
    ...(call.kind !== undefined && { kind: call.kind }),
    ...(call.recipients !== undefined && { recipients: call.recipients }),
    ...(call.repo !== undefined && { repo: call.repo }),
    ...(call.cli !== undefined && { cli: call.cli }),
    ...(call.http !== undefined && { http: call.http }),
    ...(call.runId !== undefined && { runId: call.runId }),
    ...(call.persistence !== undefined && { persistence: call.persistence }),
  };
}

/** The single-valued text fields a rule can name. */
export const TEXT_FIELDS = [
  "account",
  "provider",
  "agent",
  "action",
  "kind",
  "repo",
  "tool",
  "method",
  "path",
  "command",
  "verb",
  "subcommand",
] as const;
export type TextField = (typeof TEXT_FIELDS)[number];

/** Where a match key reads its value from. */
export type FieldRef =
  | { kind: "text"; name: TextField }
  | { kind: "recipients" }
  | { kind: "argv" }
  | { kind: "path"; root: "args" | "body"; path: readonly string[] }
  | { kind: "named"; root: "query" | "flags"; key: string };

/**
 * A field's value on one call. `absent` makes every check false (I-18). A
 * list holds every value reached; `MISSING` marks list elements whose path
 * ran out, so "every element" checks fail on them.
 */
export type FieldValue =
  | { kind: "absent" }
  | { kind: "single"; value: unknown }
  | { kind: "list"; values: readonly unknown[] };

export const MISSING: unique symbol = Symbol("missing");

const ABSENT: FieldValue = { kind: "absent" };

export function resolveField(facts: RuleFacts, field: FieldRef): FieldValue {
  switch (field.kind) {
    case "text":
      return optionalSingle(textValue(facts, field.name));
    case "recipients":
      return facts.recipients === undefined ? ABSENT : { kind: "list", values: facts.recipients };
    case "argv":
      return facts.cli === undefined ? ABSENT : { kind: "list", values: facts.cli.argv };
    case "path": {
      const root = field.root === "args" ? facts.args : facts.http?.body;
      return root === undefined ? ABSENT : resolvePath(root, field.path);
    }
    case "named": {
      const source = field.root === "query" ? facts.http?.query : facts.cli?.flags;
      if (source === undefined || !Object.hasOwn(source, field.key)) return ABSENT;
      const value: unknown = Reflect.get(source, field.key);
      return Array.isArray(value) ? { kind: "list", values: value } : { kind: "single", value };
    }
  }
}

function textValue(facts: RuleFacts, name: TextField): string | undefined {
  switch (name) {
    case "account":
    case "provider":
    case "agent":
    case "action":
    case "kind":
    case "repo":
    case "tool":
      return facts[name];
    case "method":
      return facts.http?.method;
    case "path":
      // The template when one matched, so rules can name `/repos/{o}/{r}/…`.
      return facts.http?.pathTemplate ?? facts.http?.path;
    case "command":
      return facts.cli?.command;
    case "verb":
      return facts.cli?.verb;
    case "subcommand":
      return facts.cli?.subcommand;
  }
}

function optionalSingle(value: unknown): FieldValue {
  return value === undefined ? ABSENT : { kind: "single", value };
}

/**
 * Walks a dotted path. Stepping through an array visits every element, so
 * `args.messages.id` reads each message's id (spec: "A path into an array
 * checks every element"); an array at the end of the path is a list too.
 * Only own properties of plain objects are read, so `args.constructor`
 * finds nothing.
 */
export function resolvePath(root: unknown, path: readonly string[]): FieldValue {
  let isList = false;
  let values: unknown[] = [root];
  for (const segment of path) {
    const next: unknown[] = [];
    for (const value of values) {
      if (Array.isArray(value)) {
        isList = true;
        for (const element of value) next.push(lookup(element, segment));
      } else {
        next.push(lookup(value, segment));
      }
    }
    values = next;
  }

  const leaves: unknown[] = [];
  for (const value of values) {
    if (Array.isArray(value)) {
      isList = true;
      leaves.push(...value);
    } else {
      leaves.push(value);
    }
  }
  // An empty array is a value (an empty list); a path that reached nothing is absent.
  if (leaves.length > 0 && leaves.every((value) => value === MISSING)) return ABSENT;
  if (!isList) return { kind: "single", value: leaves[0] };
  return { kind: "list", values: leaves };
}

function lookup(value: unknown, key: string): unknown {
  if (value === MISSING || typeof value !== "object" || value === null || Array.isArray(value)) {
    return MISSING;
  }
  return Object.hasOwn(value, key) ? Reflect.get(value, key) : MISSING;
}
