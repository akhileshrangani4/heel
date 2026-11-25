import type { Call } from "../../core/call.ts";
import type { Definition, Normalized } from "../../gateway/pipeline/ports.ts";
import type { AccountRecord } from "../../store/directory.ts";
import { deliveryRefusedMessage } from "../credential-delivery.ts";
import { credentialDelivery, upstreamSettings } from "./settings.ts";
import type { UpstreamPool } from "./upstream.ts";

/**
 * The definition for an MCP passthrough account: someone else's MCP server
 * behind heel.
 *
 * heel knows nothing about these tools, so a call keeps its raw tool name
 * and arguments, gets no `action`, and is never `kind: read` (I-20): rules
 * match it on the names the server uses. Every call is checked against the
 * upstream's tool list as it is now, so a tool that appears mid-run is still
 * default-denied until a rule names it. heel can't parse these responses,
 * so it can allow or deny a call but can't hide items from what comes back
 * (I-46); it only removes the account's own credential if the server echoes
 * it.
 *
 * A local server whose credential would go into its environment without the
 * operator choosing that is never started: its tools aren't listed, and a
 * call is refused (`credential_delivery`) with the fix.
 */

export const REDACTED_TEXT = "[redacted by heel]";

/** Pure: `value` with every occurrence of `secret` in its strings and keys replaced. */
export function scrubValue(value: unknown, secret: string): unknown {
  if (secret === "") return value;
  if (typeof value === "string") return value.replaceAll(secret, REDACTED_TEXT);
  if (Array.isArray(value)) return value.map((item) => scrubValue(item, secret));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key.replaceAll(secret, REDACTED_TEXT),
        scrubValue(item, secret),
      ]),
    );
  }
  return value;
}

/** The arguments a tool call carries upstream: an object, never absent. */
function argumentsOf(call: Call): Record<string, unknown> {
  const { args } = call;
  return typeof args === "object" && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

export function mcpPassthrough(account: AccountRecord, upstream: UpstreamPool): Definition {
  const settings = upstreamSettings(account.settings);
  const refused =
    settings?.transport === "stdio" && credentialDelivery(settings) === "refused"
      ? deliveryRefusedMessage(account.alias, "mcp")
      : null;
  return {
    // Never started, so nothing to list; a call naming one of its tools is refused in normalize, with the fix.
    tools: (signal) =>
      refused === null ? upstream.listTools(account, signal) : Promise.resolve([]),

    async normalize(base, ctx): Promise<Normalized> {
      if (refused !== null) return { ok: false, reason: "credential_delivery", detail: refused };
      let tools: { name: string }[];
      try {
        tools = await upstream.listTools(account, ctx.signal);
      } catch {
        // Can't tell whether the tool exists: deny rather than guess.
        return { ok: false, reason: "lookup_unavailable" };
      }
      if (!tools.some((tool) => tool.name === base.tool))
        return { ok: false, reason: "unsupported" };
      return { ok: true, call: base };
    },

    async execute(call, signal) {
      const result = await upstream.callTool(account, call.tool, argumentsOf(call), signal);
      const token = await upstream.credential(account);
      return token === null ? result : scrubValue(result, token.reveal());
    },
  };
}
