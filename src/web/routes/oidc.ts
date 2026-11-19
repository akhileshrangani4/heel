import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { OIDC_CALLBACK_PATH } from "../../config/schema.ts";
import { OidcError, type OidcIdentity, type SignInStart } from "../../teams/oidc.ts";
import { savePending, TooManySignIns, takePending, userForIdentity } from "../../teams/sign-in.ts";
import {
  continuePage,
  type HumanPlaneDeps,
  readSessionCookie,
  renderPage,
  setSessionCookie,
} from "../http.ts";
import { endSession, startSession } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { oidcSignIn, type SignInNotice } from "../ui/sign-in.ts";
import { safeNext } from "./sign-in.ts";

/**
 * Team sign-in through the organization's IdP (D13b; spec: Teams,
 * "Sign-in"): the authorization code flow with PKCE.
 *
 * - `GET /auth/oidc?next=` stores the pending sign-in server-side, binds it
 *   to this browser with a short-lived cookie, and redirects to the IdP.
 * - `GET /auth/oidc/callback` completes it only in that browser, once:
 *   state, nonce, PKCE and the ID token are checked by `OidcClient`, then
 *   the person's groups are mapped to a role. No mapped group, or a disabled
 *   user, and nobody is signed in.
 * - The session it starts lets a person see requests. Every decision still
 *   needs a fresh assertion from a passkey enrolled to that person, which
 *   only `heel user enroll` on the host can add (I-56, Q-N2).
 */

/** `__Host-` on https, so a sibling subdomain can't plant one (login CSRF). */
const bindingCookie = (publicUrl: URL) =>
  publicUrl.protocol === "https:" ? "__Host-heel_oidc" : "heel_oidc";

const MESSAGES: Record<string, string> = {
  no_role: "Your account isn't in a group that may use heel. Ask an admin.",
  disabled: "Your heel account is disabled. Ask an admin.",
  name_unavailable:
    "Your organization's user name is already taken in heel, or can't be used as a name. Ask an admin.",
  busy: "Too many sign-ins are in progress. Try again in a few minutes.",
  discovery_failed: "Your organization's sign-in isn't reachable right now. Try again shortly.",
  pkce_unsupported: "Your organization's sign-in isn't set up the way heel needs. Ask an admin.",
  expired: "That sign-in has expired or was already used. Start again.",
  sign_in_expired: "That sign-in took too long. Start again.",
  idp_error: "Your organization's sign-in was cancelled or refused.",
  token_exchange_failed: "Your organization's sign-in couldn't be completed. Start again.",
  response_invalid: "Your organization's sign-in couldn't be verified. Start again.",
  groups_malformed: "Your organization's sign-in didn't say which groups you're in. Ask an admin.",
  unavailable: "Your organization's sign-in isn't reachable right now. Try again shortly.",
};

export function oidcRoutes(deps: HumanPlaneDeps): Hono {
  const app = new Hono();
  const oidc = deps.oidc;
  if (oidc == null) return app;
  const secure = deps.publicUrl.protocol === "https:";
  const BINDING_COOKIE = bindingCookie(deps.publicUrl);
  const STATUS: Record<string, 400 | 403 | 503> = {
    no_role: 403,
    disabled: 403,
    name_unavailable: 403,
    busy: 503,
    unavailable: 503,
    discovery_failed: 503,
  };

  const failed = (c: Context, code: string) => {
    const notice: SignInNotice = {
      kind: "error",
      message: MESSAGES[code] ?? MESSAGES["expired"] ?? "",
    };
    return renderPage(
      c,
      {
        title: "Sign in",
        viewer: null,
        body: oidcSignIn({ providerName: oidc.name, startHref: "/auth/oidc", notice }),
        script: clientScript(null),
      },
      STATUS[code] ?? 400,
    );
  };

  app.get("/auth/oidc", async (c) => {
    const now = deps.now();
    let start: SignInStart;
    try {
      start = await (await oidc.client()).beginSignIn();
    } catch (error) {
      deps.log.warn({ err: error }, "OIDC sign-in couldn't start");
      return failed(c, "unavailable");
    }
    let cookie: string;
    try {
      cookie = savePending(
        deps.db,
        start.pending,
        safeNext(c.req.query("next"), deps.publicUrl),
        now,
      );
    } catch (error) {
      if (error instanceof TooManySignIns) return failed(c, "busy");
      throw error;
    }
    setCookie(c, BINDING_COOKIE, cookie, {
      path: "/",
      httpOnly: true,
      secure,
      // The IdP sends the person back with a top-level GET from its own site.
      sameSite: "Lax",
      expires: start.pending.expiresAt,
    });
    return c.redirect(start.authorizationUrl.href, 303);
  });

  app.get(OIDC_CALLBACK_PATH, async (c) => {
    const now = deps.now();
    const binding = getCookie(c, BINDING_COOKIE);
    deleteCookie(c, BINDING_COOKIE, { path: "/", secure });
    const taken = binding === undefined ? null : takePending(deps.db, binding, now);
    if (taken === null) return failed(c, "expired");
    // The URL the IdP redirected to, on heel's public origin (the registered redirect URI).
    const incoming = new URL(c.req.url);
    const callback = new URL(`${incoming.pathname}${incoming.search}`, deps.publicUrl);
    let identity: OidcIdentity;
    try {
      identity = await (await oidc.client()).completeSignIn(callback, taken.pending);
    } catch (error) {
      const code = error instanceof OidcError ? error.code : "unavailable";
      deps.log.info(
        { code, ...(error instanceof OidcError ? {} : { err: error }) },
        "OIDC sign-in refused",
      );
      return failed(c, code);
    }
    const user = userForIdentity(deps.db, deps.orgId, identity, now);
    if (!user.ok) {
      deps.log.info({ reason: user.reason }, "OIDC sign-in refused");
      return failed(c, user.reason);
    }
    // A session this browser already had ends; the new one replaces it.
    const previous = readSessionCookie(c, deps);
    if (previous !== undefined) endSession(deps.db, previous, now);
    const started = startSession(deps.db, {
      orgId: deps.orgId,
      userId: user.userId,
      method: "oidc",
      now,
    });
    setSessionCookie(c, deps, started);
    // Not a redirect: the session cookie is SameSite=Strict, and a browser doesn't send it on a
    // redirect chain the IdP started from another site. A page that moves on by itself is same-site.
    return c.html(continuePage(taken.next));
  });

  return app;
}
