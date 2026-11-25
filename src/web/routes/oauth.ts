import { Hono } from "hono";
import { isCodeChallenge, redirectWith } from "../../oauth/rules.ts";
import {
  agentForClient,
  type ClientRow,
  findClient,
  issueCode,
  OAuthError,
  plannedAgentForClient,
  redeemCode,
  refreshTokens,
  registerClient,
  type TokenPair,
} from "../../oauth/store.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  passkeyChallenge,
  passkeyFailed,
  renderPage,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
  verifiedBinding,
  viewerOf,
} from "../http.ts";
import { clientScript } from "../ui/client.ts";
import { type ConnectRequest, connectPage } from "../ui/connect.ts";

/**
 * OAuth for cloud connectors. Claude, ChatGPT, Grok and other MCP hosts
 * add heel as a custom connector; MCP authorization makes heel's human plane
 * their authorization server and the agent plane the resource server.
 *
 * - `GET /.well-known/oauth-authorization-server`: metadata (RFC 8414).
 * - `POST /oauth/register`: dynamic client registration (RFC 7591).
 * - `GET /oauth/authorize`: the person signs in and sees what's asking.
 * - `POST /oauth/authorize/challenge`, `POST /oauth/authorize/confirm`: they
 *   connect with a passkey; the request's parameters ride in the signed
 *   challenge, and heel answers with a one-time code for the client.
 * - `POST /oauth/token`: code (with its PKCE verifier) or refresh token for a
 *   token pair. Access tokens last an hour; refresh tokens rotate.
 *
 * All of it answers 404 while `agent_public_url` isn't set.
 */

function metadata(issuer: URL) {
  const at = (path: string) => new URL(path, issuer).toString();
  return {
    issuer: issuer.origin,
    authorization_endpoint: at("/oauth/authorize"),
    token_endpoint: at("/oauth/token"),
    registration_endpoint: at("/oauth/register"),
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

function tokenResponse(pair: TokenPair) {
  return {
    access_token: pair.accessToken,
    token_type: "Bearer",
    expires_in: pair.expiresInSeconds,
    refresh_token: pair.refreshToken,
  };
}

/** The authorization request's parameters, checked against the registered client. */
function readRequest(
  deps: HumanPlaneDeps,
  agentPublicUrl: URL,
  params: Record<string, string | undefined>,
): { ok: true; client: ClientRow; request: ConnectRequest } | { ok: false; message: string } {
  const client = findClient(deps.db, deps.orgId, params["client_id"] ?? "");
  if (client === null) return { ok: false, message: "The app isn't registered with heel." };
  const redirectUri = params["redirect_uri"] ?? "";
  if (!client.redirectUris.includes(redirectUri)) {
    return { ok: false, message: "The app asked to return somewhere it didn't register." };
  }
  if ((params["response_type"] ?? "code") !== "code")
    return { ok: false, message: "Only the code flow is supported." };
  const codeChallenge = params["code_challenge"] ?? "";
  if (params["code_challenge_method"] !== "S256" || !isCodeChallenge(codeChallenge)) {
    return { ok: false, message: "The app didn't send a PKCE S256 challenge." };
  }
  const resource = params["resource"] ?? agentPublicUrl.toString();
  if (!URL.canParse(resource) || new URL(resource).origin !== agentPublicUrl.origin) {
    return { ok: false, message: "The app asked for access to something other than this heel." };
  }
  return {
    ok: true,
    client,
    request: {
      clientId: client.id,
      redirectUri,
      codeChallenge,
      state: params["state"] ?? "",
      resource,
    },
  };
}

export function oauthRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const agentPublicUrl = deps.agentPublicUrl;
  if (agentPublicUrl === null) return app;
  const signedIn = requireSession(deps);
  const csrf = requireCsrfHeader();

  app.get("/.well-known/oauth-authorization-server", (c) => c.json(metadata(deps.publicUrl)));

  app.post("/oauth/register", async (c) => {
    const body = await jsonBody(c);
    const method = stringField(body, "token_endpoint_auth_method") ?? "none";
    const uris = body?.["redirect_uris"];
    if (method !== "none") {
      return c.json(
        {
          error: "invalid_client_metadata",
          error_description: "heel only registers public clients",
        },
        400,
      );
    }
    if (!Array.isArray(uris) || !uris.every((uri) => typeof uri === "string")) {
      return c.json(
        { error: "invalid_redirect_uri", error_description: "redirect_uris must be a list" },
        400,
      );
    }
    try {
      const client = registerClient(deps.db, {
        orgId: deps.orgId,
        name: stringField(body, "client_name") ?? "MCP client",
        redirectUris: uris,
        now: deps.now(),
      });
      deps.log.info({ clientId: client.id, name: client.name }, "OAuth client registered");
      return c.json(
        {
          client_id: client.id,
          client_name: client.name,
          redirect_uris: client.redirectUris,
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          client_id_issued_at: Math.floor(client.createdAt.getTime() / 1_000),
        },
        201,
      );
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      return c.json({ error: error.code, error_description: error.message }, 400);
    }
  });

  app.get("/oauth/authorize", signedIn, (c) => {
    const session = c.get("session");
    const read = readRequest(deps, agentPublicUrl, c.req.query());
    const page = (body: Parameters<typeof connectPage>[0]) =>
      renderPage(c, {
        title: "Connect an app",
        viewer: viewerOf(session),
        focus: true,
        body: connectPage(body),
        script: clientScript(session.csrfToken),
      });
    if (!read.ok) return page({ kind: "invalid", message: read.message });
    const { client, request } = read;
    const planned = plannedAgentForClient(deps.db, {
      orgId: deps.orgId,
      ownerId: session.userId,
      client,
    });
    if (planned === null) {
      return page({
        kind: "invalid",
        message: "heel couldn't find a free agent name for this app.",
      });
    }
    return page({
      kind: "ask",
      clientName: client.name,
      redirectHost: new URL(request.redirectUri).host,
      agentName: planned.name,
      newAgent: !planned.existing,
      request,
      declineHref: redirectWith(request.redirectUri, {
        error: "access_denied",
        ...(request.state === "" ? {} : { state: request.state }),
      }),
    });
  });

  app.post("/oauth/authorize/challenge", signedIn, csrf, async (c) => {
    const body = await jsonBody(c);
    const read = readRequest(deps, agentPublicUrl, {
      client_id: stringField(body, "clientId"),
      redirect_uri: stringField(body, "redirectUri"),
      code_challenge: stringField(body, "codeChallenge"),
      code_challenge_method: "S256",
      state: stringField(body, "state"),
      resource: stringField(body, "resource"),
    });
    if (!read.ok) return c.json({ ok: false, message: read.message }, 400);
    return passkeyChallenge(c, deps, "connect", { ...read.request });
  });

  app.post("/oauth/authorize/confirm", signedIn, csrf, async (c) => {
    const session = c.get("session");
    const now = deps.now();
    const binding = await verifiedBinding(c, deps, "connect", now);
    if (binding === null) return passkeyFailed(c);
    // What is being connected comes from the signed challenge, never from this body.
    const read = readRequest(deps, agentPublicUrl, {
      client_id: binding["clientId"],
      redirect_uri: binding["redirectUri"],
      code_challenge: binding["codeChallenge"],
      code_challenge_method: "S256",
      state: binding["state"],
      resource: binding["resource"],
    });
    if (!read.ok) return c.json({ ok: false, message: read.message }, 400);
    const { client, request } = read;
    const { code, agentName } = deps.db.transaction(
      (tx) => {
        const agent = agentForClient(tx, {
          orgId: deps.orgId,
          ownerId: session.userId,
          client,
          now,
        });
        const issuedCode = issueCode(tx, {
          orgId: deps.orgId,
          clientId: client.id,
          agentId: agent.agentId,
          redirectUri: request.redirectUri,
          codeChallenge: request.codeChallenge,
          now,
        });
        return { code: issuedCode, agentName: agent.name };
      },
      { behavior: "immediate" },
    );
    deps.log.info({ clientId: client.id, agent: agentName, by: session.userId }, "app connected");
    return c.json({
      ok: true,
      message: `Connected as ${agentName}. Returning to the app…`,
      next: redirectWith(request.redirectUri, {
        code,
        ...(request.state === "" ? {} : { state: request.state }),
      }),
    });
  });

  app.post("/oauth/token", async (c) => {
    const form = await c.req.parseBody();
    const field = (name: string) => (typeof form[name] === "string" ? form[name] : "");
    const now = deps.now();
    c.header("cache-control", "no-store");
    try {
      switch (field("grant_type")) {
        case "authorization_code": {
          const pair = redeemCode(deps.db, {
            orgId: deps.orgId,
            clientId: field("client_id"),
            code: field("code"),
            redirectUri: field("redirect_uri"),
            verifier: field("code_verifier"),
            now,
          });
          return c.json(tokenResponse(pair));
        }
        case "refresh_token":
          return c.json(
            tokenResponse(
              refreshTokens(deps.db, {
                orgId: deps.orgId,
                refreshToken: field("refresh_token"),
                now,
              }),
            ),
          );
        default:
          return c.json({ error: "unsupported_grant_type" }, 400);
      }
    } catch (error) {
      if (!(error instanceof OAuthError)) throw error;
      return c.json({ error: error.code, error_description: error.message }, 400);
    }
  });

  return app;
}
