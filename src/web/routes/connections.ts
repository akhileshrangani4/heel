import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { Hono } from "hono";
import {
  GOOGLE_CALLBACK_PATH,
  isLoopbackUrl,
  MICROSOFT_CALLBACK_PATH,
} from "../../config/schema.ts";
import { CALENDAR_PROFILE, GMAIL_PROFILE, googleSignIn } from "../../definitions/google/oauth.ts";
import { upstreamSettings } from "../../definitions/mcp/settings.ts";
import {
  finishUpstreamSignIn,
  startUpstreamSignIn,
  UPSTREAM_CALLBACK_PATH,
} from "../../definitions/mcp/upstream-oauth.ts";
import { microsoftSignIn } from "../../definitions/microsoft/oauth.ts";
import {
  finishSignIn,
  type ProviderSignIn,
  SignInError,
  startSignIn,
} from "../../definitions/sign-in.ts";
import { missingSignInSetup } from "../../definitions/sign-in-setup.ts";
import { needsKey } from "../../requests/connection.ts";
import { lastUsedByAccount } from "../../store/activity.ts";
import { accountsOwnedBy } from "../../store/directory.ts";
import { users } from "../../store/schema.ts";
import { sharingOf } from "../../store/sharing.ts";
import { errorShape } from "../../util/error-shape.ts";
import { type AccountNote, accountNotes } from "../account-notes.ts";
import {
  formField,
  type HumanPlaneDeps,
  renderPage,
  requireCsrfField,
  requireSession,
  type SignedInEnv,
  viewerOf,
} from "../http.ts";
import { LoopbackRedirects } from "../loopback.ts";
import { clientScript } from "../ui/client.ts";
import { type ConnectionsOutcome, connectionsPage } from "../ui/connections.ts";
import { loopbackSignInPage } from "../ui/loopback-sign-in.ts";

/** Where heel's built-in Google client finishes a sign-in, and where a pasted address goes. */
export const GOOGLE_LOOPBACK_PATH = "/connections/google/return";
const GOOGLE_PASTE_PATH = "/connections/google/paste";

/**
 * Connections: the accounts a person owns, and OAuth sign-in for remote
 * MCP servers that want it.
 *
 * - `GET /connections` lists them.
 * - `POST /connections/sign-in` starts a sign-in: heel discovers the server's
 *   authorization server, registers itself if needed, and sends the browser
 *   there.
 * - `GET /oauth/upstream/callback` finishes it: heel exchanges the code and
 *   keeps the tokens in its vault. Only the person who started a sign-in
 *   can finish it, and each one works once.
 * - Built-in mail accounts sign in the same way through the operator's own
 *   client: Gmail with Google, back to `/oauth/google/callback`, and
 *   Outlook with Microsoft, back to `/oauth/microsoft/callback`. A
 *   callback only finishes a sign-in for an account of its own provider.
 */

function isOAuthUpstream(settings: Record<string, unknown>): boolean {
  const upstream = upstreamSettings(settings);
  return upstream?.transport === "http" && upstream.oauth;
}

/**
 * Why a sign-in failed, kept here for a few minutes: the redirect carries
 * only a random id, so a link someone else crafts can't put their own words
 * in heel's error notice. An id heel didn't make shows nothing.
 */
class FailureNotes {
  readonly #notes = new Map<string, { alias: string; message: string; at: number }>();
  readonly now: () => Date;
  constructor(now: () => Date) {
    this.now = now;
  }
  add(alias: string, message: string): string {
    const at = this.now().getTime();
    for (const [id, note] of this.#notes) {
      if (at - note.at > 10 * 60_000 || this.#notes.size > 200) this.#notes.delete(id);
    }
    const id = randomBytes(12).toString("base64url");
    this.#notes.set(id, { alias, message, at });
    return id;
  }
  get(id: string): { alias: string; message: string } | null {
    return this.#notes.get(id) ?? null;
  }
}

/** The notice to show: only for an account on this page, and only heel's own words. */
function outcomeFrom(
  query: Record<string, string>,
  failures: FailureNotes,
  aliases: ReadonlySet<string>,
  /** Every account this person has, signed in or not. */
  all: ReadonlySet<string> = aliases,
  note: AccountNote | null = null,
): ConnectionsOutcome {
  const alias = query["account"] ?? "";
  if (query["connected"] !== undefined && aliases.has(alias)) return { kind: "connected", alias };
  // The web app's own changes come as a note heel wrote, never from the link itself.
  if (note !== null) {
    const agrees = note.kind === "removed" ? !all.has(note.alias) : all.has(note.alias);
    if (agrees) return note;
  }
  const failure = query["failed"] === undefined ? null : failures.get(query["failed"]);
  if (failure !== null) return { kind: "failed", alias: failure.alias, message: failure.message };
  return { kind: "none" };
}

/** Why a pasted Google address was refused, for the log; never the address itself. */
function pasteRefusal(
  pending: { userId: string } | null,
  userId: string,
  pasted: URL | null,
  state: string,
): string {
  if (pending === null) return "no such sign-in, or it expired";
  if (pending.userId !== userId) return "another person's sign-in";
  if (pasted === null) return "not an address";
  if (pasted.searchParams.get("state") !== state) return "another sign-in's address";
  return "not this sign-in's listener";
}

function back(params: Record<string, string>): string {
  return `/connections?${new URLSearchParams(params)}`;
}

export function connectionRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  const oauth = deps.upstreamOAuth;
  const failures = new FailureNotes(deps.now);
  const builtIn = deps.builtInGoogle;
  const loopbacks = new LoopbackRedirects(new URL(GOOGLE_LOOPBACK_PATH, deps.publicUrl));
  // Sign-in for built-in mail accounts, by account provider; only for the
  // providers the operator configured a client for.
  const providers = new Map<string, ProviderSignIn>();
  if (oauth !== null) {
    const http = { fetch: oauth.fetch ?? fetch, now: deps.now };
    const { google, microsoft } = deps.providerClients;
    if (google !== null) {
      providers.set("gmail", googleSignIn(http, google, GOOGLE_CALLBACK_PATH, GMAIL_PROFILE));
      providers.set(
        "google-calendar",
        googleSignIn(http, google, GOOGLE_CALLBACK_PATH, CALENDAR_PROFILE),
      );
    } else if (builtIn != null) {
      // heel's own desktop client: each sign-in gets its own loopback redirect.
      const client = { ...builtIn, redirectUri: new URL("http://127.0.0.1") };
      const loopback = { loopback: true };
      providers.set(
        "gmail",
        googleSignIn(http, client, GOOGLE_LOOPBACK_PATH, GMAIL_PROFILE, loopback),
      );
      providers.set(
        "google-calendar",
        googleSignIn(http, client, GOOGLE_LOOPBACK_PATH, CALENDAR_PROFILE, loopback),
      );
    }
    if (microsoft !== null) {
      providers.set("outlook", microsoftSignIn(http, microsoft, MICROSOFT_CALLBACK_PATH));
    }
  }

  app.get("/connections", signedIn, (c) => {
    const session = c.get("session");
    const owned = accountsOwnedBy(deps.db, session.orgId, session.userId);
    const lastUsed = lastUsedByAccount(
      deps.db,
      session.orgId,
      owned.map((a) => a.alias),
    );
    const rows = owned.map((account) => ({
      alias: account.alias,
      lastUsedAt: lastUsed.get(account.alias) ?? null,
      provider: account.provider,
      status: account.status,
      signsIn:
        providers.has(account.provider) || (oauth !== null && isOAuthUpstream(account.settings)),
      // From the config, not `providers`: that's also empty when the vault is closed.
      holdsKey: needsKey(account.provider),
      sharing: sharingOf(deps.db, session.orgId, account.alias),
      setup: missingSignInSetup(account.provider, {
        google: deps.providerClients.google !== null || builtIn != null,
        microsoft: deps.providerClients.microsoft !== null,
      }),
    }));
    return renderPage(c, {
      title: "Connections",
      viewer: viewerOf(session),
      script: clientScript(session.csrfToken),
      current: "connections",
      body: connectionsPage({
        rows,
        // "Connected" only for an account that is: a crafted link can't claim it.
        outcome: outcomeFrom(
          c.req.query(),
          failures,
          new Set(rows.filter((row) => row.status === "active").map((row) => row.alias)),
          new Set(rows.map((row) => row.alias)),
          accountNotes(deps).take(session.userId, c.req.query("note") ?? ""),
        ),
        signInForm: { action: "/connections/sign-in", csrfToken: session.csrfToken },
        now: deps.now(),
        manage: {
          csrfToken: session.csrfToken,
          people: deps.db
            .select({ id: users.id, name: users.name })
            .from(users)
            .where(and(eq(users.orgId, session.orgId), isNull(users.disabledAt)))
            .all()
            .filter((u) => u.id !== session.userId)
            .map((u) => u.name)
            .sort(),
          groups: deps.oidc != null,
          admin: session.role === "admin",
        },
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
    const provider = account === undefined ? undefined : providers.get(account.provider);
    if (account !== undefined && provider !== undefined && provider.loopback === true) {
      const redirectUri = await loopbacks.open(account.id);
      const { url, state } = startSignIn(
        { signIns: oauth.signIns, now: deps.now },
        provider,
        account,
        session.userId,
        redirectUri,
      );
      return renderPage(c, {
        title: "Sign in with Google",
        viewer: viewerOf(session),
        current: "connections",
        body: loopbackSignInPage({
          alias: account.alias,
          google: url.toString(),
          paste: { action: GOOGLE_PASTE_PATH, csrfToken: session.csrfToken },
          state,
          remote: !isLoopbackUrl(deps.publicUrl),
        }),
      });
    }
    if (account !== undefined && provider !== undefined) {
      const { url } = startSignIn(
        { signIns: oauth.signIns, now: deps.now },
        provider,
        account,
        session.userId,
      );
      return c.redirect(url.toString(), 303);
    }
    if (account === undefined || !isOAuthUpstream(account.settings)) {
      return c.text("Refused: no such account that signs in.", 404);
    }
    try {
      const url = await startUpstreamSignIn(
        {
          ...oauthDeps,
          signIns: oauth.signIns,
          ...(oauth.fetch === undefined ? {} : { fetch: oauth.fetch }),
          ...(deps.resolveHost === undefined ? {} : { resolveHost: deps.resolveHost }),
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
        back({
          account: alias,
          failed: failures.add(alias, "heel couldn't reach the server's sign-in."),
        }),
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
        back({ failed: failures.add("", "That sign-in expired or wasn't yours. Start again.") }),
        303,
      );
    }
    const account = accountsOwnedBy(deps.db, session.orgId, session.userId).find(
      (a) => a.id === pending.accountId,
    );
    const alias = account?.alias ?? "";
    try {
      await finishUpstreamSignIn(
        {
          ...oauthDeps,
          ...(oauth.fetch === undefined ? {} : { fetch: oauth.fetch }),
          ...(deps.resolveHost === undefined ? {} : { resolveHost: deps.resolveHost }),
        },
        { state, pending },
        params,
      );
    } catch (error) {
      deps.log.warn({ account: alias, error: errorShape(error) }, "upstream sign-in failed");
      return c.redirect(
        back({
          account: alias,
          failed: failures.add(alias, "The server didn't accept the sign-in."),
        }),
        303,
      );
    }
    deps.log.info({ account: alias, by: session.userId }, "signed in to an upstream MCP server");
    return c.redirect(back({ account: alias, connected: "1" }), 303);
  });

  // A browser that isn't on heel's host can't load the loopback redirect; the
  // person pastes its address here instead. Only an address for this
  // sign-in's own listener, for a sign-in this person started, goes on to
  // the callback, which checks everything again.
  app.post(GOOGLE_PASTE_PATH, signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const state = (await formField(c, "state")) ?? "";
    const typed = ((await formField(c, "address")) ?? "").trim();
    // Some browsers copy the address without its scheme.
    const address = /^https?:\/\//i.test(typed) ? typed : `http://${typed}`;
    const pending = oauth?.signIns.get(state, deps.now()) ?? null;
    const pasted = URL.parse(address);
    const ownListener =
      pending !== null &&
      pending.userId === session.userId &&
      pending.redirectUri !== undefined &&
      pasted !== null &&
      pasted.origin === new URL(pending.redirectUri).origin &&
      pasted.pathname === "/" &&
      pasted.searchParams.get("state") === state;
    if (!ownListener || pasted === null) {
      // Why, without the address itself (it carries the sign-in code).
      const reason = pasteRefusal(pending, session.userId, pasted, state);
      deps.log.info({ by: session.userId, reason }, "Google sign-in paste refused");
      return c.redirect(
        back({
          failed: failures.add(
            "",
            "That isn't the address Google sent you to for this sign-in. Start the sign-in again and paste the address of the page that didn't load.",
          ),
        }),
        303,
      );
    }
    const forward = new URLSearchParams();
    for (const key of ["code", "state", "error"]) {
      const value = pasted.searchParams.get(key);
      if (value !== null) forward.set(key, value);
    }
    return c.redirect(`${GOOGLE_LOOPBACK_PATH}?${forward}`, 303);
  });

  // One route per callback path; Gmail and Google Calendar share Google's.
  const callbackPaths = new Set([...providers.values()].map((p) => p.callbackPath));
  for (const callbackPath of callbackPaths) {
    app.get(callbackPath, signedIn, async (c) => {
      const session = c.get("session");
      const params = new URL(c.req.url).searchParams;
      const pending = oauth.signIns.take(params.get("state") ?? "", deps.now());
      const account =
        pending === null
          ? undefined
          : accountsOwnedBy(deps.db, session.orgId, session.userId).find(
              (a) => a.id === pending.accountId,
            );
      const provider = account === undefined ? undefined : providers.get(account.provider);
      // Only the person who started this sign-in can finish it, and only for
      // an account whose provider comes back to this callback.
      if (
        pending === null ||
        pending.userId !== session.userId ||
        account === undefined ||
        provider === undefined ||
        provider.callbackPath !== callbackPath
      ) {
        if (pending !== null && provider?.loopback === true) loopbacks.close(pending.accountId);
        return c.redirect(
          back({ failed: failures.add("", "That sign-in expired or wasn't yours. Start again.") }),
          303,
        );
      }
      if (provider.loopback === true) loopbacks.close(account.id);
      try {
        const { mailbox } = await finishSignIn(
          { db: deps.db, vault: oauth.vault },
          provider,
          pending,
          params,
        );
        deps.log.info(
          { account: account.alias, mailbox, by: session.userId },
          `signed in to ${provider.label}`,
        );
      } catch (error) {
        deps.log.warn(
          { account: account.alias, error: errorShape(error) },
          `${provider.label} sign-in failed`,
        );
        const message =
          error instanceof SignInError
            ? error.message
            : `${provider.label} didn't accept the sign-in.`;
        return c.redirect(
          back({ account: account.alias, failed: failures.add(account.alias, message) }),
          303,
        );
      }
      return c.redirect(back({ account: account.alias, connected: "1" }), 303);
    });
  }

  return app;
}
