import { createHash, randomBytes } from "node:crypto";
import { createMcpHandler, Server } from "@modelcontextprotocol/server";

/**
 * A remote MCP server that wants OAuth sign-in, with its own authorization
 * server, for testing heel as an OAuth client (D5c). Two hosts behind one
 * `fetch`:
 *
 * - https://auth.upstream.test: metadata, registration, authorize (which
 *   approves at once and redirects back, as if the person clicked "Allow"),
 *   and a token endpoint that checks PKCE and rotates refresh tokens;
 * - https://mcp.upstream.test/mcp: an MCP server that answers 401 without a
 *   valid access token, with `echo_auth` echoing the Authorization header.
 */

export const UPSTREAM_MCP_URL = "https://mcp.upstream.test/mcp";
const AUTH = "https://auth.upstream.test";

export function oauthUpstream() {
  const clients = new Map<string, string[]>();
  const codes = new Map<string, { challenge: string; clientId: string }>();
  const accessTokens = new Set<string>();
  const refreshTokens = new Set<string>();
  const issued: string[] = [];

  const issuePair = () => {
    const access = `upstream-access-${randomBytes(6).toString("hex")}`;
    const refresh = `upstream-refresh-${randomBytes(6).toString("hex")}`;
    accessTokens.add(access);
    refreshTokens.add(refresh);
    issued.push(access);
    return Response.json({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3_600,
      refresh_token: refresh,
    });
  };

  const mcp = createMcpHandler(({ requestInfo }) => {
    const server = new Server(
      { name: "linear", version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler("tools/list", async () => ({
      tools: [
        {
          name: "echo_auth",
          description: "Echo the Authorization header.",
          inputSchema: { type: "object" },
        },
      ],
    }));
    server.setRequestHandler("tools/call", async () => ({
      content: [
        { type: "text", text: `auth: ${requestInfo?.headers.get("authorization") ?? "none"}` },
      ],
    }));
    return server;
  });

  async function fetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin === "https://mcp.upstream.test") {
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({ resource: UPSTREAM_MCP_URL, authorization_servers: [AUTH] });
      }
      const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (!accessTokens.has(token)) {
        return new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="https://mcp.upstream.test/.well-known/oauth-protected-resource"`,
          },
        });
      }
      return mcp.fetch(request);
    }
    if (url.origin !== AUTH) throw new Error(`no route to ${url.origin}`);
    switch (url.pathname) {
      case "/.well-known/oauth-authorization-server":
        return Response.json({
          issuer: AUTH,
          authorization_endpoint: `${AUTH}/authorize`,
          token_endpoint: `${AUTH}/token`,
          registration_endpoint: `${AUTH}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
      case "/register": {
        const body = (await request.json()) as { redirect_uris: string[] };
        const clientId = `client-${clients.size + 1}`;
        clients.set(clientId, body.redirect_uris);
        return Response.json({ ...body, client_id: clientId }, { status: 201 });
      }
      case "/authorize": {
        const clientId = url.searchParams.get("client_id") ?? "";
        const redirect = url.searchParams.get("redirect_uri") ?? "";
        if (!clients.get(clientId)?.includes(redirect))
          return new Response("bad redirect", { status: 400 });
        const code = `code-${randomBytes(6).toString("hex")}`;
        codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", clientId });
        const back = new URL(redirect);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state") ?? "");
        return Response.redirect(back.toString(), 302);
      }
      case "/token": {
        const form = new URLSearchParams(await request.text());
        if (form.get("grant_type") === "refresh_token") {
          const refresh = form.get("refresh_token") ?? "";
          if (!refreshTokens.delete(refresh))
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          return issuePair();
        }
        const entry = codes.get(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const challenge = createHash("sha256").update(verifier).digest("base64url");
        if (entry === undefined || entry.challenge !== challenge) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        codes.delete(form.get("code") ?? "");
        return issuePair();
      }
      default:
        return new Response("not found", { status: 404 });
    }
  }

  return { fetch, issued, clients };
}
