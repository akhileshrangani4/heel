import type { Definition, DefinitionRegistry } from "../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../store/directory.ts";
import { isCliProvider, isHttpProvider, isMcpProvider } from "../vault/connect.ts";
import type { ApiDeps } from "./api-deps.ts";
import { googleCalendarDefinition } from "./calendar/google.ts";
import { type CliDeps, cliDefinition } from "./cli/definition.ts";
import { githubDefinition } from "./github/definition.ts";
import { gmailDefinition } from "./gmail/definition.ts";
import { httpDefinition } from "./http/definition.ts";
import { linearDefinition } from "./linear/definition.ts";
import { mcpPassthrough } from "./mcp/passthrough.ts";
import type { UpstreamPool } from "./mcp/upstream.ts";
import { notionDefinition } from "./notion/definition.ts";
import { outlookDefinition } from "./outlook/definition.ts";
import { slackDefinition } from "./slack/definition.ts";
import { stripeDefinition } from "./stripe/definition.ts";

interface RegistryDeps {
  upstream: UpstreamPool;
  /** Null where no vault is open, as in some tests: Gmail calls are then denied. */
  gmail: ApiDeps | null;
  /** The same for Outlook. */
  outlook?: ApiDeps | null;
  /** The same for Google Calendar. */
  googleCalendar?: ApiDeps | null;
  notion?: ApiDeps | null;
  stripe?: ApiDeps | null;
  linear?: ApiDeps | null;
  slack?: ApiDeps | null;
  http?: ApiDeps | null;
  github?: ApiDeps | null;
  /** Absent or null denies every `heel run`. */
  cli?: CliDeps | null;
}

interface BuiltIn {
  /** This service's deps; null denies its calls. */
  deps(deps: RegistryDeps): ApiDeps | null;
  definition(account: AccountRecord, deps: ApiDeps): Definition | null;
}

/** heel's own definitions, by provider. Gmail's deps are required, so only null turns it off. */
const BUILT_IN = new Map<string, BuiltIn>([
  ["gmail", { deps: (d) => d.gmail, definition: gmailDefinition }],
  [
    "google-calendar",
    { deps: (d) => d.googleCalendar ?? null, definition: googleCalendarDefinition },
  ],
  ["github", { deps: (d) => d.github ?? null, definition: githubDefinition }],
  ["notion", { deps: (d) => d.notion ?? null, definition: notionDefinition }],
  ["stripe", { deps: (d) => d.stripe ?? null, definition: stripeDefinition }],
  ["linear", { deps: (d) => d.linear ?? null, definition: linearDefinition }],
  ["slack", { deps: (d) => d.slack ?? null, definition: slackDefinition }],
  ["outlook", { deps: (d) => d.outlook ?? null, definition: outlookDefinition }],
]);

/**
 * Which definition serves an account: an MCP passthrough for `mcp:<alias>`,
 * heel's own for a built-in provider it has one for, and none otherwise, so
 * every call on such an account is denied (`provider_unavailable`).
 */
export function definitionRegistry(deps: RegistryDeps): DefinitionRegistry {
  return {
    forAccount(account) {
      if (isMcpProvider(account.provider)) return mcpPassthrough(account, deps.upstream);
      if (isHttpProvider(account.provider)) {
        return deps.http == null ? null : httpDefinition(account, deps.http);
      }
      if (isCliProvider(account.provider)) {
        return deps.cli == null ? null : cliDefinition(account, deps.cli);
      }
      const builtIn = BUILT_IN.get(account.provider);
      if (builtIn === undefined) return null;
      const serviceDeps = builtIn.deps(deps);
      return serviceDeps === null ? null : builtIn.definition(account, serviceDeps);
    },
  };
}
