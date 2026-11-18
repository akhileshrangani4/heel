import type { DefinitionRegistry } from "../gateway/pipeline/ports.ts";
import { isMcpProvider } from "../vault/connect.ts";
import { type GmailDeps, gmailDefinition } from "./gmail/definition.ts";
import { mcpPassthrough } from "./mcp/passthrough.ts";
import type { UpstreamPool } from "./mcp/upstream.ts";
import { type OutlookDeps, outlookDefinition } from "./outlook/definition.ts";

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
}): DefinitionRegistry {
  return {
    forAccount(account) {
      if (isMcpProvider(account.provider)) return mcpPassthrough(account, deps.upstream);
      if (account.provider === "gmail" && deps.gmail !== null) {
        return gmailDefinition(account, deps.gmail);
      }
      if (account.provider === "outlook" && deps.outlook != null) {
        return outlookDefinition(account, deps.outlook);
      }
      return null;
    },
  };
}
