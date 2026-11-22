import type { ListenAddress } from "../config/schema.ts";

/** Pure: the MCP URL an agent should be given, from the agent plane's listen address. */
export function agentMcpUrl(listen: ListenAddress, publicUrl: URL | null = null): string {
  // Code mode (bare /mcp) runs on every host, so that's what an agent gets: two tools,
  // however many accounts are connected. `?tools=direct` stays for clients that want one tool each.
  if (publicUrl !== null) return new URL("mcp", publicUrl.href.replace(/\/?$/, "/")).href;
  // A wildcard listen address (a container) is reached at localhost, not 0.0.0.0.
  const wildcard = listen.host === "0.0.0.0" || listen.host === "::";
  const host = wildcard
    ? "localhost"
    : listen.host.includes(":")
      ? `[${listen.host}]`
      : listen.host;
  return `http://${host}:${listen.port}/mcp`;
}
