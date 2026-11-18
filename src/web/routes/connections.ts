import { Hono } from "hono";
import { upstreamSettings } from "../../definitions/mcp/settings.ts";
import {
  finishUpstreamSignIn,
  startUpstreamSignIn,
  UPSTREAM_CALLBACK_PATH,
} from "../../definitions/mcp/upstream-oauth.ts";
import { accountsOwnedBy } from "../../store/directory.ts";
import { errorShape } from "../../util/error-shape.ts";
import {
  formField,
  type HumanPlaneDeps,
  renderPage,
  requireCsrfField,
  requireSession,
  type SignedInEnv,
  viewerOf,
} from "../http.ts";
import { type ConnectionsOutcome, connectionsPage } from "../ui/connections.ts";

/**
 * Connections (D5c): the accounts a person owns, and OAuth sign-in for remote
 * MCP servers that want it.
 *
 * - `GET /connections` lists them.
 * - `POST /connections/sign-in` starts a sign-in: heel discovers the server's
 *   authorization server, registers itself if needed, and sends the browser
 *   there.
 * - `GET /oauth/upstream/callback` finishes it: heel exchanges the code and
 *   keeps the tokens in its vault. Only the person who started a sign-in
 *   can finish it, and each one works once.
 */

function isOAuthUpstream(settings: Record<string, unknown>): boolean {
  const upstream = upstreamSettings(settings);
  return upstream?.transport === "http" && upstream.oauth;
}

function outcomeFrom(query: Record<string, string>): ConnectionsOutcome {
  const alias = query["account"] ?? "";
  if (query["connected"] !== undefined) return { kind: "connected", alias };
  if (query["failed"] !== undefined)
    return { kind: "failed", alias, message: query["failed"] ?? "" };
  return { kind: "none" };
}

function back(params: Record<string, string>): string {
  return `/connections?${new URLSearchParams(params)}`;
}

export function connectionRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  const oauth = deps.upstreamOAuth;

  app.get("/connections", signedIn, (c) => {
    const session = c.get("session");
    const rows = accountsOwnedBy(deps.db, session.orgId, session.userId).map((account) => ({
      alias: account.alias,
      provider: account.provider,
      status: account.status,
      signsIn: oauth !== null && isOAuthUpstream(account.settings),
    }));
    return renderPage(c, {
      title: "Connections",
      viewer: viewerOf(session),
      current: "connections",
      body: connectionsPage({
        rows,
        outcome: outcomeFrom(c.req.query()),
        signInForm: { action: "/connections/sign-in", csrfToken: session.csrfToken },
      }),
    });
  });

  if (oauth === null) return app;
  const oauthDeps = { db: deps.db, vault: oauth.vault, publicUrl: deps.publicUrl, now: deps.now };

  app.post("/connections/sign-in", signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const alias = (await formField(c, "alias")) ?? "";
    const account = accountsOwnedBy(deps.db, session.orgId, session.userId).find(
      (a) => a.alias === alias,
    );
    if (account === undefined || !isOAuthUpstream(account.settings)) {
      return c.text("Refused: no such account that signs in.", 404);
    }
    try {
      const url = await startUpstreamSignIn(
        {
          ...oauthDeps,
          signIns: oauth.signIns,
          ...(oauth.fetch === undefined ? {} : { fetch: oauth.fetch }),
        },
        account,
        session.userId,
      );
      return c.redirect(url.toString(), 303);
    } catch (error) {
      deps.log.warn(
        { account: alias, error: errorShape(error) },
        "upstream sign-in couldn't start",
      );
      return c.redirect(
        back({ account: alias, failed: "heel couldn't reach the server's sign-in." }),
        303,
      );
    }
  });

  app.get(UPSTREAM_CALLBACK_PATH, signedIn, async (c) => {
    const session = c.get("session");
    const params = new URL(c.req.url).searchParams;
    const state = params.get("state") ?? "";
    const pending = oauth.signIns.take(state, deps.now());
    // Only the person who started this sign-in can finish it.
    if (pending === null || pending.userId !== session.userId) {
      return c.redirect(
        back({ failed: "That sign-in expired or wasn't yours. Start again." }),
        303,
      );
    }
    const account = accountsOwnedBy(deps.db, session.orgId, session.userId).find(
      (a) => a.id === pending.accountId,
    );
    const alias = account?.alias ?? "";
    try {
      await finishUpstreamSignIn(
        { ...oauthDeps, ...(oauth.fetch === undefined ? {} : { fetch: oauth.fetch }) },
        { state, pending },
        params,
      );
    } catch (error) {
      deps.log.warn({ account: alias, error: errorShape(error) }, "upstream sign-in failed");
      return c.redirect(
        back({ account: alias, failed: "The server didn't accept the sign-in." }),
        303,
      );
    }
    deps.log.info({ account: alias, by: session.userId }, "signed in to an upstream MCP server");
    return c.redirect(back({ account: alias, connected: "1" }), 303);
  });

  return app;
}
