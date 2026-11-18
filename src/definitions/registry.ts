import type { DefinitionRegistry } from "../gateway/pipeline/ports.ts";
import { isCliProvider, isHttpProvider, isMcpProvider } from "../vault/connect.ts";
import { type GoogleCalendarDeps, googleCalendarDefinition } from "./calendar/google.ts";
import { type CliDeps, cliDefinition } from "./cli/definition.ts";
import { type GitHubDeps, githubDefinition } from "./github/definition.ts";
import { type GmailDeps, gmailDefinition } from "./gmail/definition.ts";
import { type HttpDeps, httpDefinition } from "./http/definition.ts";
import { type LinearDeps, linearDefinition } from "./linear/definition.ts";
import { mcpPassthrough } from "./mcp/passthrough.ts";
import type { UpstreamPool } from "./mcp/upstream.ts";
import { type NotionDeps, notionDefinition } from "./notion/definition.ts";
import { type OutlookDeps, outlookDefinition } from "./outlook/definition.ts";
import { type SlackDeps, slackDefinition } from "./slack/definition.ts";
import { type StripeDeps, stripeDefinition } from "./stripe/definition.ts";

/**
 * Which definition serves an account: an MCP passthrough for `mcp:<alias>`,
 * heel's own for a built-in provider it has one for, and none otherwise, so
 * every call on such an account is denied (`provider_unavailable`).
 */
export function definitionRegistry(deps: {
  upstream: UpstreamPool;
  /** Null where no vault is open, as in some tests: Gmail calls are then denied. */
  gmail: GmailDeps | null;
  /** The same for Outlook. */
  outlook?: OutlookDeps | null;
  /** The same for Google Calendar. */
  googleCalendar?: GoogleCalendarDeps | null;
  /** Notion (D12b). */
  notion?: NotionDeps | null;
  /** Stripe (D12b). */
  stripe?: StripeDeps | null;
  /** Linear (D12b). */
  linear?: LinearDeps | null;
  /** Slack (D12b). */
  slack?: SlackDeps | null;
  /** HTTP accounts (D7a). */
  http?: HttpDeps | null;
  /** GitHub (D11). */
  github?: GitHubDeps | null;
  /** CLI accounts (D8b); absent or null denies every `heel run`. */
  cli?: CliDeps | null;
}): DefinitionRegistry {
  return {
    forAccount(account) {
      if (isMcpProvider(account.provider)) return mcpPassthrough(account, deps.upstream);
      if (isHttpProvider(account.provider)) {
        return deps.http == null ? null : httpDefinition(account, deps.http);
      }
      if (isCliProvider(account.provider)) {
        return deps.cli == null ? null : cliDefinition(account, deps.cli);
      }
      if (account.provider === "gmail" && deps.gmail !== null) {
        return gmailDefinition(account, deps.gmail);
      }
      if (account.provider === "google-calendar" && deps.googleCalendar != null) {
        return googleCalendarDefinition(account, deps.googleCalendar);
      }
      if (account.provider === "github" && deps.github != null) {
        return githubDefinition(account, deps.github);
      }
      if (account.provider === "notion" && deps.notion != null) {
        return notionDefinition(account, deps.notion);
      }
      if (account.provider === "stripe" && deps.stripe != null) {
        return stripeDefinition(account, deps.stripe);
      }
      if (account.provider === "linear" && deps.linear != null) {
        return linearDefinition(account, deps.linear);
      }
      if (account.provider === "slack" && deps.slack != null) {
        return slackDefinition(account, deps.slack);
      }
      if (account.provider === "outlook" && deps.outlook != null) {
        return outlookDefinition(account, deps.outlook);
      }
      return null;
    },
  };
}
