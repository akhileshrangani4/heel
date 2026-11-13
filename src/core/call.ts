/**
 * The normalized call every surface produces before any rule sees it (spec:
 * Call model and normalization). Rules, counts, approvals and audit only ever
 * see this record. The pipeline that builds it lands in D3; D1 defines the
 * shape so the store and audit log agree on it from the first migration.
 */
export type Surface = "mcp" | "code" | "http" | "cli";

export interface CliFields {
  command: string;
  verb?: string;
  subcommand?: string;
  flags: Record<string, string | true>;
  argv: string[];
}

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
  cli?: CliFields;
  http?: HttpFields;
  /** The tool creates something that outlives revocation (I-70). */
  persistence?: boolean;
}

/** Where a rule lives, as shown in audit and on the approval page. */
export interface RuleRef {
  name: string | null;
  file: string;
  line: number;
}

export const PAUSE_SCOPES = ["global", "agent", "account", "provider"] as const;
export type PauseScope = (typeof PAUSE_SCOPES)[number];
