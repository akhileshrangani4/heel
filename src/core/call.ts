/**
 * The normalized call every surface produces before any rule sees it (spec:
 * Call model and normalization). Rules, counts, approvals and audit only ever
 * see this record. The pipeline that builds it lands in D3; D1 defines the
 * shape so the store and audit log agree on it from the first migration.
 */
export type Surface = "mcp" | "code" | "http" | "cli";

/**
 * A parsed CLI flag: `true` when given bare, its value when given once, every
 * value in order when repeated (so a rule can check each one).
 */
export type CliFlagValue = string | true | string[];

export interface CliFields {
  command: string;
  verb?: string;
  subcommand?: string;
  flags: Record<string, CliFlagValue>;
  argv: string[];
}

/** The provider fields rules can name; see `Call.fields`. */
export const PROVIDER_FIELDS = [
  /** Slack: the channel id. */
  "channel",
  /** Slack: the channel is shared with another organization (Slack Connect). */
  "external",
  /** Linear: the team key. */
  "team",
  /** Linear: the project id. */
  "project",
  /** Notion: the parent page or database id. */
  "parent",
  /** Stripe: the amount in the currency's smallest unit. */
  "amount",
  /** Stripe: the three-letter currency code, lower-case. */
  "currency",
  /** Stripe: the customer id. */
  "customer",
] as const;
export type ProviderField = (typeof PROVIDER_FIELDS)[number];
export type ProviderFields = Partial<Record<ProviderField, string | number | boolean>>;

/** What rules see of an HTTP proxy request (spec: HTTP proxy, "What rules see"). */
export interface HttpFields {
  method: string;
  /** The literal request path. */
  path: string;
  /** The OpenAPI or built-in path template the path matched, when one did. */
  pathTemplate?: string;
  /** The decoded query; a repeated key holds every value. */
  query: Record<string, string | string[]>;
  /** Parsed from JSON or form bodies; absent for any other content type. */
  body?: unknown;
  /**
   * A body was sent in a content type heel doesn't parse. A rule that checks
   * `body.*` can't be decided, so the call is denied rather than the check
   * read as false (which would let a broader rule below match).
   */
  bodyUnreadable?: true;
}

export interface Call {
  // who
  /** Single org per install in v1. */
  orgId: string;
  /** From the heel token, never from the request body. */
  agentId: string;
  /** The user who owns the agent. */
  ownerId: string;
  /** Agent-supplied; scoped per agent. */
  runId?: string;

  // what
  surface: Surface;
  /** Alias, e.g. "gmail-work"; HTTP and CLI use the connected alias. */
  account: string;
  /** "gmail" | "outlook" | "github" | … | "mcp:<alias>" | "http:<alias>" | "cli:<name>" */
  provider: string;
  /** Native tool name, raw upstream tool name, "<METHOD> <path-template>", or the CLI command path. */
  tool: string;
  /** Exactly what will be executed, after heel's own rewrites (e.g. a pinned sha). */
  args: unknown;

  // derived by the provider definition (absent when unknown)
  action?: string;
  /** Only from built-in definitions (I-20). */
  kind?: "read" | "write";
  /** Lower-cased addr-specs: to ∪ cc ∪ bcc ∪ derived. */
  recipients?: string[];
  /** Expanded item count; 1 when unknown. */
  items: number;
  /** Ids the call touches (messages, PRs), for hidden-target checks and audit. */
  targets?: string[];
  /** "owner/name" for GitHub. */
  repo?: string;
  /** The calendar a calendar call touches: Google's calendar id, or Outlook's calendar id. */
  calendar?: string;
  cli?: CliFields;
  http?: HttpFields;
  /**
   * What a built-in definition derives about the resource a call touches,
   * for rules to name (D12b; spec: "Calendar, Slack, Linear, Notion,
   * Stripe"). Only built-in definitions set these (I-20).
   */
  fields?: ProviderFields;
  /** The tool creates something that outlives revocation (I-70). */
  persistence?: boolean;
}

/** Where a rule lives, as shown in audit and on the approval page. */
export interface RuleRef {
  name: string | null;
  file: string;
  line: number;
}

/**
 * What a pause covers (spec: Pause). `owner` pauses every agent a person
 * owns, so a member can stop all of their agents in one tap; like every
 * pause, it can only stop calls.
 */
export const PAUSE_SCOPES = ["global", "owner", "agent", "account", "provider"] as const;
export type PauseScope = (typeof PAUSE_SCOPES)[number];
