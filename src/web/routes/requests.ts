import { and, eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { canonicalHash } from "../../core/canonical.ts";
import { resolveAll } from "../../definitions/mcp/public-only.ts";
import { missingSignInSetup } from "../../definitions/sign-in-setup.ts";
import { compileGrant } from "../../grants/compile.ts";
import { serviceActions } from "../../requests/actions.ts";
import {
  approveRequest,
  findRequest,
  KEY_HINTS,
  needsKey,
  pendingRequests,
  publicHostProblem,
  type RequestRow,
  rejectRequest,
  serviceLabel,
} from "../../requests/connection.ts";
import { coverage } from "../../requests/coverage.ts";
import { liveGrants } from "../../store/grants.ts";
import { modeFor } from "../../store/modes.ts";
import { accounts, agents, users } from "../../store/schema.ts";
import { ConnectError, connectAccount } from "../../vault/connect.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  renderPage,
  requireCsrfField,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
  viewerOf,
} from "../http.ts";
import type { SessionView } from "../sessions.ts";
import { clientScript } from "../ui/client.ts";
import { html } from "../ui/html.ts";
import { type RequestCard, requestCards, requestPage } from "../ui/requests.ts";

/**
 * Connection requests on the human plane (roadmap 2.5).
 *
 * - `GET /requests/:id` shows what the agent asks for in heel's words, its
 *   own words labelled as its claim, and what the owner's rules would let it
 *   do with the account.
 * - `POST /requests/challenge` then `POST /requests/confirm` connect it,
 *   with a passkey bound to the request and a hash of what it asks for. The
 *   account is made from the stored request, never from the confirm body.
 * - `POST /requests/:id/reject` is a plain form: it only keeps things as
 *   they are.
 *
 * Only the requesting agent's owner sees or decides a request. Nothing the
 * agent named is contacted here: a sign-in, if the account needs one, starts
 * from the Connections sign-in route after approval.
 */

function nameOf(deps: HumanPlaneDeps, table: "user" | "agent", id: string): string {
  const row =
    table === "user"
      ? deps.db.select({ name: users.name }).from(users).where(eq(users.id, id)).get()
      : deps.db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get();
  return row?.name ?? "unknown";
}

function ownRequest(deps: HumanPlaneDeps, session: SessionView, id: string): RequestRow | null {
  const row = findRequest(deps.db, deps.orgId, id);
  return row !== null && row.ownerId === session.userId ? row : null;
}

/** Longer than any real API key; a paste past it is a mistake. */
const MAX_KEY_CHARS = 8_192;

/** What the passkey signs: the request and exactly what it asks for. */
function requestHash(row: RequestRow): string {
  return canonicalHash({ id: row.id, kind: row.kind, details: row.details });
}

/** Why it can't be connected as asked; checked when the page loads and again on confirm. */
function problemOf(deps: HumanPlaneDeps, row: RequestRow): string | null {
  const agent = deps.db
    .select({ revokedAt: agents.revokedAt })
    .from(agents)
    .where(eq(agents.id, row.agentId))
    .get();
  if (agent === undefined || agent.revokedAt !== null) {
    return "The agent that asked has been revoked. Reject this request.";
  }
  const taken = deps.db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.orgId, deps.orgId), eq(accounts.alias, row.details.alias)))
    .get();
  return taken === undefined
    ? null
    : `This heel already has an account named ${row.details.alias}. Reject this and ask the agent for another name.`;
}

/** Waiting requests for the Approvals page. */
export function requestCardsFor(deps: HumanPlaneDeps, session: SessionView, now: Date) {
  const cards: RequestCard[] = pendingRequests(deps.db, session.userId, now).map((row) => ({
    id: row.id,
    agent: nameOf(deps, "agent", row.agentId),
    service: serviceLabel(row.details),
    provider: row.details.provider,
    alias: row.details.alias,
    why: row.why,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  }));
  return { count: cards.length, cards: requestCards(cards, now) };
}

export function requestRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);
  const signIns = {
    google: deps.providerClients.google !== null || deps.builtInGoogle != null,
    microsoft: deps.providerClients.microsoft !== null,
  };

  const notFound = (c: Context<SignedInEnv>, session: SessionView) =>
    renderPage(
      c,
      {
        title: "Not found",
        viewer: viewerOf(session),
        current: "approvals",
        body: html`<h1>Not found</h1>
          <p>There's no request with that id for you.</p>`,
      },
      404,
    );

  app.get("/requests/:id", signedIn, (c) => {
    const session = c.get("session");
    const now = deps.now();
    pendingRequests(deps.db, session.userId, now); // expires old ones first
    const row = ownRequest(deps, session, c.req.param("id"));
    if (row === null) return notFound(c, session);
    const agent = nameOf(deps, "agent", row.agentId);
    const { details } = row;
    const account =
      row.accountId === null
        ? undefined
        : deps.db
            .select({ status: accounts.status })
            .from(accounts)
            .where(eq(accounts.id, row.accountId))
            .get();
    const query = c.req.query();
    return renderPage(c, {
      title: "Connection request",
      viewer: viewerOf(session),
      current: "approvals",
      body: requestPage({
        id: row.id,
        agent,
        status: row.status,
        service: serviceLabel(details),
        provider: details.provider,
        alias: details.alias,
        url: details.url ?? null,
        oauth: details.oauth ?? false,
        why: row.why,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
        decision:
          row.decidedBy === null || row.decidedAt === null
            ? null
            : { by: nameOf(deps, "user", row.decidedBy), at: row.decidedAt },
        now,
        coverage: coverage(deps.rules.set, nameOf(deps, "user", row.ownerId), agent, details, {
          actions: serviceActions(details.provider),
          grants: liveGrants(deps.db, deps.orgId, row.agentId, now).flatMap((g) => {
            try {
              return [{ id: g.id, rule: compileGrant(g.match, { id: g.id }).rule }];
            } catch {
              return [];
            }
          }),
          mode: modeFor(
            deps.db,
            deps.orgId,
            row.ownerId,
            deps.watchFallback ? "shadow" : "enforce",
          ),
        }),
        problem: problemOf(deps, row),
        setup: missingSignInSetup(details.provider, signIns),
        hash: requestHash(row),
        reject: {
          action: `/requests/${encodeURIComponent(row.id)}/reject`,
          csrfToken: session.csrfToken,
        },
        signIn:
          account !== undefined && account.status !== "active" && deps.upstreamOAuth !== null
            ? { action: "/connections/sign-in", csrfToken: session.csrfToken }
            : null,
        // Only the outcome the request actually had, whatever the link says.
        outcome:
          "approved" in query && row.status === "approved"
            ? "approved"
            : "rejected" in query && row.status === "rejected"
              ? "rejected"
              : null,
        // Only a caution, so a crafted link can show it and do no harm.
        unchecked: "unchecked" in query,
        key: needsKey(details.provider)
          ? { hint: KEY_HINTS[details.provider as keyof typeof KEY_HINTS] }
          : null,
      }),
      script: clientScript(session.csrfToken),
    });
  });

  app.post("/requests/:id/reject", signedIn, requireCsrfField(), (c) => {
    const session = c.get("session");
    const row = ownRequest(deps, session, c.req.param("id"));
    if (row === null) return notFound(c, session);
    rejectRequest(deps.db, row, session.userId, deps.now());
    deps.log.info({ request: row.id, by: session.userId }, "connection request rejected");
    return c.redirect(`/requests/${encodeURIComponent(row.id)}?rejected`, 303);
  });

  app.post("/requests/challenge", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const row = ownRequest(deps, session, stringField(body, "requestId") ?? "");
    if (row === null || row.status !== "pending" || row.expiresAt < deps.now()) {
      return c.json({ ok: false, message: "That request isn't waiting for you." }, 404);
    }
    // The page showed the request as it was stored; sign only that.
    const hash = requestHash(row);
    if (stringField(body, "hash") !== hash) {
      return c.json({ ok: false, message: "This request changed. Reload the page." }, 409);
    }
    const problem = problemOf(deps, row);
    if (problem !== null) return c.json({ ok: false, message: problem }, 409);
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "connection",
      userId: session.userId,
      binding: { request: row.id, hash },
      now: deps.now(),
    });
    if (!issued.ok) return c.json({ ok: false, message: "You have no passkey enrolled." }, 400);
    return c.json(issued);
  });

  app.post("/requests/confirm", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "connection",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now: deps.now(),
    });
    if (!verified.ok) return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    // What to connect comes from the signed challenge and the stored request, never this body.
    const { request, hash } = verified.binding;
    const now = deps.now();
    const row = typeof request === "string" ? ownRequest(deps, session, request) : null;
    if (
      row === null ||
      row.status !== "pending" ||
      row.expiresAt < now ||
      hash !== requestHash(row)
    ) {
      return c.json({ ok: false, message: "That request isn't waiting for you." }, 409);
    }
    const { details } = row;
    const problem = problemOf(deps, row);
    if (problem !== null) return c.json({ ok: false, message: problem }, 409);
    // A key the owner pasted: the one thing read from this body. It goes to the vault and nowhere
    // else: not the request row, not a log line, not the redirect.
    const pasted = stringField(body, "key")?.trim() ?? "";
    if (needsKey(details.provider) && (pasted === "" || pasted.length > MAX_KEY_CHARS)) {
      return c.json(
        { ok: false, message: `Paste the ${serviceLabel(details)} key, then connect again.` },
        400,
      );
    }
    // A key the service turns down is never stored, and the request keeps waiting (T12).
    const checked =
      needsKey(details.provider) && deps.checkKey !== undefined
        ? await deps.checkKey(details.provider, pasted)
        : null;
    if (checked?.status === "rejected") return c.json({ ok: false, message: checked.message }, 409);
    // A name the agent gave may resolve inside the network; check before heel ever contacts it.
    if (details.url !== undefined) {
      const unsafe = await publicHostProblem(details.url, deps.resolveHost ?? resolveAll);
      if (unsafe !== null) return c.json({ ok: false, message: unsafe }, 409);
    }
    let approved: ReturnType<typeof approveRequest>;
    try {
      approved = approveRequest(
        deps.db,
        row,
        session.userId,
        now,
        () =>
          connectAccount(
            deps.db,
            deps.upstreamOAuth?.vault ?? null,
            {
              orgId: deps.orgId,
              ownerId: row.ownerId,
              provider: details.provider,
              alias: details.alias,
              ...(details.url === undefined ? {} : { url: details.url }),
              ...(details.oauth === undefined ? {} : { oauth: details.oauth }),
              // heel contacts this server, its redirects and its sign-in only on public hosts.
              ...(details.url === undefined ? {} : { publicOnly: true }),
              ...(needsKey(details.provider)
                ? { credential: { type: "static" as const, value: pasted } }
                : {}),
            },
            now,
          ).accountId,
      );
    } catch (error) {
      if (!(error instanceof ConnectError)) throw error;
      return c.json({ ok: false, message: error.message }, 409);
    }
    if (!approved.ok) return c.json({ ok: false, message: approved.problem }, 409);
    deps.log.warn(
      {
        request: row.id,
        agent: nameOf(deps, "agent", row.agentId),
        account: details.alias,
        provider: details.provider,
        by: session.userId,
      },
      "requested connection added",
    );
    const unchecked = checked?.status === "unchecked" ? "&unchecked" : "";
    return c.json({
      ok: true,
      next: `/requests/${encodeURIComponent(row.id)}?approved${unchecked}`,
    });
  });

  return app;
}
