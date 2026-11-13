import { z } from "zod";

/**
 * The rules file schema (spec: Rules). The README's examples are the grammar;
 * this adds what they leave out. One schema serves `org-rules.yaml` and every
 * `rules/<user>.yaml`: `{ rules: Rule[], hide?: HideEntry[] }`.
 *
 * Zod checks shapes and which operators each field accepts. What needs more
 * than a shape (regex syntax, addresses, domains, dotted keys, org ceilings,
 * state-check services) is checked when the file is compiled, with the same
 * file:line reporting.
 */

export const DECISIONS = ["allow", "deny", "ask"] as const;
export type Decision = (typeof DECISIONS)[number];

const scalar = z.union([z.string(), z.number(), z.boolean()], {
  error: "expected a string, number or boolean",
});
const nonEmpty = <T extends z.ZodType>(item: T) =>
  z.array(item).min(1, { error: "needs at least one value" });
const domains = nonEmpty(z.string()).meta({
  description: "Domains; `*.example.com` also matches subdomains.",
});
const maxCount = z.number().int().min(0);

/** A condition is a scalar shorthand for `equals`, or an object of operators. */
function condition<S extends z.ZodType, O extends z.ZodType>(shorthand: S, ops: O, what: string) {
  return z.union([shorthand, ops], {
    error: `expected ${what}, or an object of operators`,
  });
}

/** Single text values: account, provider, agent, action, repo, tool, method, path, command, verb, subcommand. */
export const TextCondition = condition(
  z.string(),
  z.strictObject({
    equals: z.string().optional(),
    one_of: nonEmpty(z.string()).optional(),
    any_of: nonEmpty(z.string()).optional(),
    matches: z.string().optional(),
  }),
  "a string",
).meta({ id: "TextCondition" });

const kindValue = z.enum(["read", "write"]);
export const KindCondition = condition(
  kindValue,
  z.strictObject({
    equals: kindValue.optional(),
    one_of: nonEmpty(kindValue).optional(),
    any_of: nonEmpty(kindValue).optional(),
  }),
  "read or write",
).meta({ id: "KindCondition" });

/** Lists of text: `argv`, and `labels` in hide entries. */
export const TextListCondition = condition(
  z.string(),
  z.strictObject({
    equals: z.union([z.string(), z.array(z.string())]).optional(),
    one_of: nonEmpty(z.string()).optional(),
    any_of: nonEmpty(z.string()).optional(),
    matches: z.string().optional(),
    max: maxCount.optional(),
  }),
  "a string",
).meta({ id: "TextListCondition" });

const addressOps = {
  equals: z.union([z.string(), z.array(z.string())]).optional(),
  one_of: nonEmpty(z.string()).optional(),
  any_of: nonEmpty(z.string()).optional(),
  matches: z.string().optional(),
  any_domain_in: domains.optional(),
  all_domain_in: domains.optional(),
};

/** A single address: `from` in hide entries. */
export const AddressCondition = condition(
  z.string(),
  z.strictObject({ ...addressOps, equals: z.string().optional() }),
  "an email address",
).meta({ id: "AddressCondition" });

/** A list of addresses: `to` in hide entries. */
export const AddressListCondition = condition(
  z.string(),
  z.strictObject({ ...addressOps, max: maxCount.optional() }),
  "an email address",
).meta({ id: "AddressListCondition" });

/** `recipients`: an address list that also takes the `all_in_thread` state check. */
export const RecipientsCondition = condition(
  z.string(),
  z.strictObject({
    ...addressOps,
    max: maxCount.optional(),
    all_in_thread: z.literal(true, { error: "all_in_thread can only be true" }).optional().meta({
      description: "State check: every recipient is already on a thread this account sent to.",
    }),
  }),
  "an email address",
).meta({ id: "RecipientsCondition" });

/** Dotted paths whose shape heel can't know: `args.*`, `body.*`, `query.*`, `flags.*`. */
export const ValueCondition = condition(
  scalar,
  z.strictObject({
    equals: z.union([scalar, z.array(scalar)]).optional(),
    one_of: nonEmpty(scalar).optional(),
    any_of: nonEmpty(scalar).optional(),
    matches: z.string().optional(),
    any_domain_in: domains.optional(),
    all_domain_in: domains.optional(),
    max: z.number().optional(),
  }),
  "a string, number or boolean",
).meta({ id: "ValueCondition" });

export const ItemsCondition = z
  .strictObject({
    over: maxCount,
    per: z.enum(["run", "hour"]).optional(),
  })
  .meta({
    id: "ItemsCondition",
    description:
      "Holds when the items counted (this call's alone, or per run or per sliding hour, including this call) exceed `over`.",
  });

export const ChecksCondition = z
  .literal("passing", { error: 'checks can only be "passing"' })
  .meta({ description: "State check: the PR's required checks pass on its current head." });

/** Match keys with a fixed meaning, and the condition each takes. */
const fixedMatchKeys = {
  account: TextCondition.optional(),
  provider: TextCondition.optional(),
  agent: TextCondition.optional(),
  action: TextCondition.optional(),
  kind: KindCondition.optional(),
  recipients: RecipientsCondition.optional(),
  repo: TextCondition.optional(),
  checks: ChecksCondition.optional(),
  items: ItemsCondition.optional(),
  tool: TextCondition.optional(),
  method: TextCondition.optional(),
  path: TextCondition.optional(),
  command: TextCondition.optional(),
  verb: TextCondition.optional(),
  subcommand: TextCondition.optional(),
  argv: TextListCondition.optional(),
};
export type FixedMatchKey = keyof typeof fixedMatchKeys;
export const FIXED_MATCH_KEYS = Object.keys(fixedMatchKeys) as readonly FixedMatchKey[];

/**
 * Dotted keys: `args.a.b` and `body.a.b` walk into the call's arguments or
 * request body; `query.<k>` and `flags.<name>` name one query parameter or
 * CLI flag. Kept here so the compiler and the JSON Schema agree.
 */
export const PATH_KEY_PATTERN = "^(args|body)\\.[^.]+(\\.[^.]+)*$";
export const NAMED_KEY_PATTERN = "^(query|flags)\\..+$";

export const Match = z.object(fixedMatchKeys).catchall(ValueCondition).meta({
  id: "Match",
  description:
    "Every key must hold (AND). A key naming a field the call doesn't have doesn't match. `{}` matches every call.",
});

export const Rule = z
  .strictObject({
    name: z
      .string()
      .min(1)
      .optional()
      .meta({ description: "Stable id shown in audit and on the approval page." }),
    match: Match,
    // biome-ignore lint/suspicious/noThenProperty: `then` is the README's rules grammar.
    then: z.enum(DECISIONS),
    watch: z.boolean().optional().meta({
      description: "Log what this rule would decide, then keep evaluating as if it hadn't matched.",
    }),
  })
  .meta({ id: "Rule" });

export const LOOKS_LIKE = ["password_reset", "login_code"] as const;
const looksLike = z.enum(LOOKS_LIKE);

export const HideEmail = z
  .strictObject({
    from: AddressCondition.optional(),
    to: AddressListCondition.optional().meta({ description: "To, Cc and Bcc together." }),
    subject: TextCondition.optional(),
    labels: TextListCondition.optional(),
    looks_like: z.union([looksLike, nonEmpty(looksLike)]).optional(),
  })
  .meta({
    id: "HideEmail",
    description: "Keys in one entry are ANDed; a message matching any entry is hidden.",
  });

/** v1 hides email only (spec: Hiding, Q-H4). */
export const HideEntry = z.strictObject({ email: HideEmail }).meta({ id: "HideEntry" });

export const RulesFile = z
  .strictObject({
    rules: z.array(Rule).optional(),
    hide: z.array(HideEntry).optional(),
  })
  .meta({
    title: "heel rules file",
    description:
      "org-rules.yaml or rules/<user>.yaml. Org rules run first, then the agent owner's rules top to bottom; the first match wins and no match denies.",
  });

export type RulesFileInput = z.output<typeof RulesFile>;
export type RuleInput = z.output<typeof Rule>;
export type MatchInput = z.output<typeof Match>;
export type HideEmailInput = z.output<typeof HideEmail>;

/**
 * The JSON Schema for editor completion (`heel rules schema`) and the
 * committed `schema/heel-rules.schema.json`. Zod can't express "fixed keys or
 * a dotted prefix" for match keys, so `propertyNames` is added here from the
 * same constants the compiler uses.
 */
export function rulesJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(RulesFile, { io: "input", target: "draft-2020-12" });
  const defs = schema.$defs;
  const match = defs?.["Match"];
  if (match === undefined || typeof match === "boolean") {
    throw new Error("rules JSON Schema has no Match definition");
  }
  match.propertyNames = {
    anyOf: [
      { enum: [...FIXED_MATCH_KEYS] },
      { pattern: PATH_KEY_PATTERN },
      { pattern: NAMED_KEY_PATTERN },
    ],
  };
  return schema;
}

/** The exact bytes committed as `schema/heel-rules.schema.json`. */
export function renderRulesJsonSchema(): string {
  return `${JSON.stringify(rulesJsonSchema(), null, 2)}\n`;
}
