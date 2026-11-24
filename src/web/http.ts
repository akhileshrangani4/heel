import type { FetchLike } from "@modelcontextprotocol/client";
import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { RulesPaths } from "../config/rules.ts";
import type { LearningThreshold } from "../core/learning.ts";
import type { BuiltInGoogleClient } from "../definitions/google/builtin.ts";
import type { GoogleClient } from "../definitions/google/oauth.ts";
import type { UpstreamSignIns } from "../definitions/mcp/upstream-oauth.ts";
import type { MicrosoftClient } from "../definitions/microsoft/oauth.ts";
import type { RulesSource } from "../gateway/pipeline/pipeline.ts";
import type { PauseStore } from "../gateway/pipeline/ports.ts";
import type { Logger } from "../log.ts";
import type { SqliteApprovalStore } from "../store/approvals.ts";
import type { HeelDb } from "../store/db.ts";
import type { OidcClient } from "../teams/oidc.ts";
import type { KeyCheck } from "../vault/key-check.ts";
import type { Vault } from "../vault/vault.ts";
import type { Passkeys } from "./passkeys.ts";
import {
  csrfMatches,
  readSession,
  type SessionView,
  type StartedSession,
  sessionCookieName,
} from "./sessions.ts";
import { toHtmlString } from "./ui/html.ts";
import { type PageProps, page, type Viewer } from "./ui/layout.ts";
import { waitingVersion } from "./waiting.ts";

/**
 * Plumbing every human-plane route shares: its dependencies, who is signed
 * in, and the checks every state-changing request passes. Routes stay small
 * because the rules about cookies, origins and CSRF live only here.
 */

/** A running or parked background script, as the Agents page lists it. */
export interface BackgroundListing {
  id: string;
  agentId: string;
  agentName: string;
  status: string;
  approvalId: string | null;
  calls: number;
  startedAt: Date;
}

export interface HumanPlaneDeps {
  db: HeelDb;
  orgId: string;
  log: Logger;
  /** The plane's public origin: the WebAuthn origin, and the only origin a POST may come from. */
  publicUrl: URL;
  passkeys: Passkeys;
  approvals: SqliteApprovalStore;
  pauses: PauseStore;
  /** The rules in force, to tell a live standing approval from a lapsed one. */
  rules: RulesSource;
  /** The configured approval adapters' names, so the page can say hints are on the way. */
  hintAdapters?: readonly string[];
  /** When heel suggests rules from what people decide (2.10); absent or null turns suggestions off. */
  learning?: LearningThreshold | null;
  /** The VAPID public key devices subscribe to approval notifications with. */
  vapidPublicKey: string;
  /** The agent plane's public URL when OAuth for connectors is on (A2); null when off. */
  agentPublicUrl: URL | null;
  /** After an account's key changes or it goes: a running local MCP server for it restarts (2.9). */
  onAccountConfigured?: (accountId: string) => void;
  /** The MCP address a new agent is given, as `heel agent add` prints it (2.9). */
  agentMcpUrl?: string;
  /**
   * Sign-in to remote MCP servers that want OAuth (D5c). Null when the vault
   * is closed, since the tokens would have nowhere to go.
   */
  upstreamOAuth: { signIns: UpstreamSignIns; vault: Vault; fetch?: FetchLike } | null;
  /**
   * Checks a key the owner pasted with its service before heel stores it
   * (roadmap T12). heel's own server passes one; when absent, keys are stored
   * unchecked, so tests never reach a real API.
   */
  checkKey?: (provider: string, key: string) => Promise<KeyCheck>;
  /**
   * Background code-mode scripts (C6): told when an approval's decision has
   * committed, so a script parked on it resumes or ends; and the running and
   * parked scripts the owner may see and stop. Absent without code mode.
   */
  background?: {
    approvalDecided(approvalId: string): void;
    list(ownerIds: readonly string[] | null): readonly BackgroundListing[];
    stop(id: string): boolean;
    /** Whether a background script is parked on this approval: Approve then starts it again. */
    waitsOn(approvalId: string): boolean;
    /** Ends the background script parked on this approval (the approval page's Stop the script). */
    stopWaitingOn(approvalId: string): void;
  };
  /**
   * The operator's own OAuth clients, for signing in built-in mail accounts:
   * Google for Gmail (D9a-1), Microsoft for Outlook (D9b). Each is null when
   * heel.yaml doesn't configure it. Sign-ins share `upstreamOAuth`'s state
   * store, vault and fetch.
   */
  providerClients: { google: GoogleClient | null; microsoft: MicrosoftClient | null };
  /**
   * heel's own Google client (roadmap 1.14), used when `providerClients.google`
   * is null: Gmail and Calendar then sign in through a loopback redirect on
   * heel's host, with a paste-back for browsers elsewhere. Null in a build
   * without one; absent in tests that don't need it.
   */
  builtInGoogle?: BuiltInGoogleClient | null;
  /**
   * Team sign-in (D13b): the IdP's client, discovered on first use, and the
   * name the sign-in page shows. Null on single-user installs.
   */
  oidc?: { client: () => Promise<OidcClient>; name: string } | null;
  /**
   * The owner rules files, for adding the rules an agent proposed (roadmap
   * 2.1), and a reload so they take effect at once. Absent where heel has no
   * rules files of its own to write, which turns adding off.
   */
  /** `reload` says whether every rules file loaded, so what was just saved is in force. */
  ruleFiles?: { paths: RulesPaths; reload: () => boolean | void };
  /** `heel serve --watch`: rows with no stored mode behave as shadow (A3). */
  watchFallback: boolean;
  /** Resolves a host name to its addresses; tests pass a fake. Defaults to DNS. */
  resolveHost?: (host: string) => Promise<readonly string[]>;
  /** Messages hidden from agents since heel started, by reason (A5, I-44); absent in tests. */
  hiddenCounts?: () => Readonly<Record<string, number>>;
  now: () => Date;
}

/** What a route behind `requireSession` can read from the context. */
export interface SignedInEnv {
  Variables: { session: SessionView; approvalsWaiting?: number; waitingVersion?: string };
}

/** The header the page script sends its CSRF token in; plain forms send a `csrf` field. */
export const CSRF_HEADER = "x-heel-csrf";

export function viewerOf(session: SessionView): Viewer {
  return { name: session.userName, role: session.role, csrfToken: session.csrfToken };
}

/** Renders a full page. Every human-plane page goes through `page()`, so all share one layout. */
export function renderPage(
  c: Context,
  props: PageProps,
  status: 200 | 400 | 403 | 404 | 503 = 200,
): Response {
  // requireSession counts what waits for the viewer once per page, for the menu, title and banner.
  const signedIn = c as Context<SignedInEnv>;
  const waiting = props.waiting ?? signedIn.get("approvalsWaiting");
  const version = signedIn.get("waitingVersion");
  // no-cache: a page the browser or the installed app restores revalidates
  // first, so it never shows a request as waiting after it was decided.
  // A route that set its own (no-store, for a page showing a one-time secret) keeps it.
  if (!c.res.headers.has("cache-control")) c.header("Cache-Control", "no-cache");
  const full = {
    ...props,
    ...(waiting === undefined ? {} : { waiting }),
    ...(version === undefined ? {} : { waitingVersion: version }),
  };
  return c.html(toHtmlString(page(full)), status);
}

// ── sessions ────────────────────────────────────────────────────────────────

/**
 * Lets a request through only with a live session. A page request without
 * one goes to the sign-in page; anything else gets 401, since a script
 * can't follow a redirect into a passkey prompt.
 */
export function requireSession(deps: HumanPlaneDeps): MiddlewareHandler<SignedInEnv> {
  return async (c, next) => {
    const cookie = getCookie(c, sessionCookieName(deps.publicUrl));
    const session = cookie === undefined ? null : readSession(deps.db, cookie, deps.now());
    if (session === null || session.orgId !== deps.orgId) {
      if (c.req.method === "GET") {
        // Path and query: an OAuth authorize request needs its parameters back after sign-in.
        const url = new URL(c.req.url);
        const next = encodeURIComponent(url.pathname + url.search);
        return c.redirect(`/sign-in?next=${next}`, 303);
      }
      return c.json({ error: "signed_out" }, 401);
    }
    c.set("session", session);
    if (c.req.method === "GET") {
      // Calls, connection requests, rule changes and recovery links: one count everywhere.
      const { waiting, version } = waitingVersion(deps, session, deps.now());
      c.set("approvalsWaiting", waiting);
      c.set("waitingVersion", version);
    }
    return next();
  };
}

export function setSessionCookie(c: Context, deps: HumanPlaneDeps, started: StartedSession): void {
  setCookie(c, sessionCookieName(deps.publicUrl), started.cookieValue, {
    path: "/",
    httpOnly: true,
    secure: deps.publicUrl.protocol === "https:",
    // Lax, not Strict: a link or redirect from another site (a Slack or email
    // notification, a connector's sign-in, Google or an MCP server sending
    // you back) is a top-level GET, and it should arrive signed in. Lax still
    // keeps the cookie off cross-site forms, frames and scripts, and every
    // change needs a same-origin POST with a CSRF token on top; deciding
    // needs a passkey. GET routes change nothing a state check doesn't guard.
    sameSite: "Lax",
    expires: started.expiresAt,
  });
}

export function readSessionCookie(c: Context, deps: HumanPlaneDeps): string | undefined {
  return getCookie(c, sessionCookieName(deps.publicUrl));
}

export function clearSessionCookie(c: Context, deps: HumanPlaneDeps): void {
  deleteCookie(c, sessionCookieName(deps.publicUrl), {
    path: "/",
    secure: deps.publicUrl.protocol === "https:",
  });
}

// ── checks on every state-changing request ──────────────────────────────────

/**
 * Refuses a POST that didn't come from heel's own pages. Browsers send
 * `Origin` on every POST, so a missing or foreign one is refused outright.
 * This runs before CSRF, and also guards the sign-in and enrollment posts,
 * which have no session yet.
 */
/**
 * OAuth endpoints a connector's servers call directly, server to server. They
 * send no Origin and carry no session; each checks its own credentials
 * (client registration, code plus PKCE verifier, refresh token).
 */
const SERVER_TO_SERVER_PATHS = new Set(["/oauth/register", "/oauth/token"]);

export function requireSameOrigin(deps: HumanPlaneDeps): MiddlewareHandler {
  return async (c, next) => {
    if (SERVER_TO_SERVER_PATHS.has(new URL(c.req.url).pathname)) return next();
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      if (c.req.header("origin") !== deps.publicUrl.origin) {
        return c.json({ error: "cross_origin" }, 403);
      }
    }
    return next();
  };
}

/**
 * For script requests from a signed-in page: the CSRF token must arrive in
 * the `x-heel-csrf` header. Runs after `requireSession`.
 */
export function requireCsrfHeader(): MiddlewareHandler<SignedInEnv> {
  return async (c, next) => {
    if (!csrfMatches(c.get("session").csrfToken, c.req.header(CSRF_HEADER))) {
      return c.json({ ok: false, message: "This page is stale. Reload it." }, 403);
    }
    return next();
  };
}

/**
 * For plain form posts from a signed-in page: the CSRF token must arrive in
 * the `csrf` field. Runs after `requireSession`; read fields with `formField`.
 */
export function requireCsrfField(): MiddlewareHandler<SignedInEnv> {
  return async (c, next) => {
    const form = await c.req.parseBody();
    const submitted = typeof form["csrf"] === "string" ? form["csrf"] : undefined;
    if (!csrfMatches(c.get("session").csrfToken, submitted)) {
      return c.text("Refused: this form is stale. Reload the page.", 403);
    }
    return next();
  };
}

/** A text field of a form post (Hono caches the parsed body after `requireCsrfField`). */
export async function formField(c: Context, name: string): Promise<string | undefined> {
  const value = (await c.req.parseBody())[name];
  return typeof value === "string" ? value : undefined;
}

/** Reads a JSON body; null when it is missing or isn't JSON. */
export async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** A string field from a parsed body, or undefined. */
export function stringField(body: Record<string, unknown> | null, key: string): string | undefined {
  const value = body?.[key];
  return typeof value === "string" ? value : undefined;
}
