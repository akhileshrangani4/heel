import type { MiddlewareHandler } from "hono";

/**
 * DNS-rebinding protection for the agent plane (MCP transport security).
 *
 * A web page can point its own domain at 127.0.0.1 and make the browser send
 * requests to a local server. heel's bearer token already stops those (the
 * page can't read it), but heel also refuses any request whose Host, or
 * whose Origin when a browser sent one, isn't a name it serves:
 *
 * - a loopback name (localhost, 127.0.0.1, [::1]) on any port;
 * - the host the agent plane listens on;
 * - the host of `agent_public_url`, for agents behind a reverse proxy.
 *
 * MCP clients and cloud connectors call from servers and send no Origin.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isServedHost(hostname: string, extra: ReadonlySet<string>): boolean {
  return LOOPBACK.has(hostname) || extra.has(hostname);
}

export function requireServedHost(hosts: readonly string[]): MiddlewareHandler {
  const extra = new Set(hosts.map((host) => host.toLowerCase()));
  return async (c, next) => {
    // The request URL's host is the Host header the client sent (the Node adapter builds it from that).
    const hostname = new URL(c.req.url).hostname.toLowerCase();
    const origin = c.req.header("origin");
    const originHost =
      origin === undefined
        ? null
        : URL.canParse(origin)
          ? new URL(origin).hostname.toLowerCase()
          : "";
    const hostOk = isServedHost(hostname, extra);
    const originOk = originHost === null || isServedHost(originHost, extra);
    if (!hostOk || !originOk)
      return c.json({ status: "denied", reason: "unknown_host", rule: null }, 403);
    return next();
  };
}
