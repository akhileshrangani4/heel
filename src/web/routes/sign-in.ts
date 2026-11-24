import { Hono } from "hono";
import { issueChallenge, openChallenge } from "../challenges.ts";
import {
  clearSessionCookie,
  type HumanPlaneDeps,
  jsonBody,
  readSessionCookie,
  renderPage,
  requireCsrfField,
  requireSession,
  type SignedInEnv,
  setSessionCookie,
  stringField,
} from "../http.ts";
import { anyPasskeyEnrolled } from "../passkeys.ts";
import { endSession, readSession, startSession } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { oidcSignIn, passkeySignIn, type SignInNotice } from "../ui/sign-in.ts";

/**
 * Passkey sign-in (single-user installs, and every decision on team
 * installs). Signing in only lets a person see requests: every approve,
 * deny and resume asks for the passkey again (spec: The approval page).
 *
 * The flow:
 * - `GET /sign-in` renders the page with a one-time challenge id. The
 *   challenge carries where to go next, so the redirect can't be swapped later.
 * - `POST /sign-in/options` returns that challenge's WebAuthn options.
 * - `POST /sign-in` verifies the assertion and starts a session.
 * - `POST /sign-out` ends it.
 */

const HOME = "/approvals";

/**
 * Only a path on this site, so sign-in can't send anyone elsewhere: it must
 * start with one `/`, hold no backslash or control character (browsers read
 * a backslash or a tab after the first `/` as the start of another host), and
 * resolve to this origin.
 */
export function safeNext(value: string | undefined, publicUrl?: URL): string {
  if (value === undefined || !value.startsWith("/") || value.startsWith("//")) return HOME;
  if (
    [...value].some((ch) => ch === "\\" || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  ) {
    return HOME;
  }
  const base = publicUrl ?? new URL("https://heel.invalid");
  let resolved: URL;
  try {
    resolved = new URL(value, base);
  } catch {
    return HOME;
  }
  if (resolved.origin !== base.origin) return HOME;
  if (resolved.pathname.startsWith("/sign-in")) return HOME;
  // Resolving collapses dot segments: `/.//evil.example` becomes the path
  // `//evil.example`, which a browser reads as another host. Check what is
  // returned, not only what came in.
  if (resolved.pathname.startsWith("//") || resolved.pathname.startsWith("/\\")) return HOME;
  return `${resolved.pathname}${resolved.search}${resolved.hash}`;
}

function noticeFrom(query: Record<string, string>): SignInNotice {
  if (query["signed-out"] !== undefined) return { kind: "signed-out" };
  if (query["enrolled"] !== undefined) return { kind: "enrolled" };
  // Set by requireSession when the browser's session cookie no longer opens one.
  if (query["expired"] !== undefined) return { kind: "session-expired" };
  return { kind: "none" };
}

export function signInRoutes(deps: HumanPlaneDeps): Hono {
  const app = new Hono();

  app.get("/sign-in", (c) => {
    const now = deps.now();
    const cookie = readSessionCookie(c, deps);
    if (cookie !== undefined && readSession(deps.db, cookie, now) !== null) {
      return c.redirect(safeNext(c.req.query("next")), 303);
    }
    // A team install signs people in through the IdP.
    if (deps.oidc != null) {
      const next = safeNext(c.req.query("next"), deps.publicUrl);
      return renderPage(c, {
        title: "Sign in",
        viewer: null,
        body: oidcSignIn({
          providerName: deps.oidc.name,
          startHref: `/auth/oidc?next=${encodeURIComponent(next)}`,
          notice: noticeFrom(c.req.query()),
        }),
        script: clientScript(null),
      });
    }
    const challenge = issueChallenge(deps.db, {
      orgId: deps.orgId,
      userId: null,
      purpose: "sign_in",
      binding: { next: safeNext(c.req.query("next")) },
      now,
    });
    return renderPage(c, {
      title: "Sign in",
      viewer: null,
      body: passkeySignIn({
        onSignIn: { handler: "signIn" },
        challengeId: challenge.id,
        enrolled: anyPasskeyEnrolled(deps.db, deps.orgId),
        notice: noticeFrom(c.req.query()),
      }),
      script: clientScript(null),
    });
  });

  app.post("/sign-in/options", async (c) => {
    // A team install signs people in through the IdP only.
    if (deps.oidc != null)
      return c.json({ ok: false, message: "Sign in with your organization." }, 404);
    const challengeId = stringField(await jsonBody(c), "challengeId") ?? "";
    const row = openChallenge(deps.db, deps.orgId, challengeId, "sign_in", deps.now());
    if (row === null) {
      return c.json({ ok: false, message: "This sign-in page has expired. Reload it." }, 400);
    }
    return c.json(await deps.passkeys.signInOptions(row));
  });

  app.post("/sign-in", async (c) => {
    if (deps.oidc != null)
      return c.json({ ok: false, message: "Sign in with your organization." }, 404);
    const body = await jsonBody(c);
    const now = deps.now();
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "sign_in",
      userId: null,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now,
    });
    if (!verified.ok) {
      deps.log.info({ reason: verified.reason }, "passkey sign-in refused");
      return c.json({ ok: false, message: "That passkey didn't sign you in." }, 401);
    }
    const started = startSession(deps.db, {
      orgId: deps.orgId,
      userId: verified.userId,
      method: "passkey",
      now,
    });
    setSessionCookie(c, deps, started);
    return c.json({ ok: true, next: safeNext(verified.binding["next"]) });
  });

  const signedIn = new Hono<SignedInEnv>();
  signedIn.post("/sign-out", requireSession(deps), requireCsrfField(), async (c) => {
    const cookie = readSessionCookie(c, deps);
    if (cookie !== undefined) endSession(deps.db, cookie, deps.now());
    clearSessionCookie(c, deps);
    return c.redirect("/sign-in?signed-out", 303);
  });
  app.route("/", signedIn);

  return app;
}
