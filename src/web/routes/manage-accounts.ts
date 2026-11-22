import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { resolveAll } from "../../definitions/mcp/public-only.ts";
import {
  agentUrlProblem,
  needsKey,
  publicHostProblem,
  REQUESTABLE_SERVICES,
} from "../../requests/connection.ts";
import { accounts } from "../../store/schema.ts";
import { ConnectError, connectAccount, isValidAlias } from "../../vault/connect.ts";
import { removeAccount, setAccountCredential } from "../../vault/manage.ts";
import { accountNotes } from "../account-notes.ts";
import {
  type HumanPlaneDeps,
  jsonBody,
  requireCsrfField,
  requireCsrfHeader,
  requireSession,
  type SignedInEnv,
  stringField,
} from "../http.ts";
import type { SessionView } from "../sessions.ts";

/**
 * Accounts from the web app (roadmap 2.9), as `heel connect`, `heel account
 * set` and `heel account remove` do them on the host. Connecting one and
 * replacing its key ask for a passkey; removing one is a plain form, since it
 * only takes access away. People manage the accounts they own.
 *
 * A pasted key is read from the confirm body only, after the passkey, and goes
 * to the vault and nowhere else: not the challenge, a log line, or a redirect.
 * A key the service turns down is never stored.
 */

const MAX_KEY_CHARS = 8_192;
const SERVICES = new Set<string>([...REQUESTABLE_SERVICES, "mcp"]);

export function manageAccountRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  function owned(session: SessionView, alias: string) {
    return (
      deps.db
        .select({ id: accounts.id, provider: accounts.provider })
        .from(accounts)
        .where(
          and(
            eq(accounts.orgId, deps.orgId),
            eq(accounts.alias, alias),
            eq(accounts.ownerId, session.userId),
          ),
        )
        .get() ?? null
    );
  }

  function intentOf(session: SessionView, body: Record<string, unknown> | null) {
    const op = stringField(body, "op") ?? "";
    // Without the vault there's nowhere to keep a key or a sign-in: say so before the passkey.
    if (deps.upstreamOAuth === null) {
      return {
        problem:
          "heel's vault isn't open (no master key), so it can't store accounts. Start heel with its master key.",
      };
    }
    const alias = (stringField(body, "alias") ?? "").trim();
    if (op === "connect") {
      const service = stringField(body, "service") ?? "";
      if (!SERVICES.has(service)) return { problem: "Pick a service." };
      if (!isValidAlias(alias)) {
        return {
          problem: "A name is 1 to 64 lower-case letters, digits or '-', starting with a letter.",
        };
      }
      const taken = deps.db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.orgId, deps.orgId), eq(accounts.alias, alias)))
        .get();
      if (taken !== undefined)
        return { problem: `This heel already has an account named ${alias}.` };
      if (service === "mcp") {
        const url = (stringField(body, "url") ?? "").trim();
        const problem = agentUrlProblem(url);
        if (problem !== null) return { problem };
        // Whether it signs in with OAuth (most do); one that doesn't connects as it is.
        const oauth = stringField(body, "oauth") === "no" ? "no" : "yes";
        return { binding: { op, service, alias, url, oauth } };
      }
      return { binding: { op, service, alias } };
    }
    if (op === "rekey") {
      const account = owned(session, alias);
      if (account === null) return { problem: "There's no account of yours by that name." };
      if (!needsKey(account.provider)) {
        return { problem: "This account signs in instead of holding a key: sign in again below." };
      }
      // The account itself, not just its name: one removed and reconnected meanwhile isn't it.
      return { binding: { op, alias, account: account.id } };
    }
    return { problem: "Unknown change." };
  }

  app.post("/connections/manage/challenge", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const intent = intentOf(session, await jsonBody(c));
    if ("problem" in intent) return c.json({ ok: false, message: intent.problem }, 400);
    const issued = await deps.passkeys.assertionOptions({
      orgId: deps.orgId,
      purpose: "account",
      userId: session.userId,
      binding: intent.binding,
      now: deps.now(),
    });
    if (!issued.ok) return c.json({ ok: false, message: "You have no passkey enrolled." }, 400);
    return c.json(issued);
  });

  app.post("/connections/manage/confirm", signedIn, requireCsrfHeader(), async (c) => {
    const session = c.get("session");
    const body = await jsonBody(c);
    const verified = await deps.passkeys.verifyAssertion({
      orgId: deps.orgId,
      purpose: "account",
      userId: session.userId,
      challengeId: stringField(body, "challengeId") ?? "",
      response: body?.["response"],
      now: deps.now(),
    });
    if (!verified.ok) return c.json({ ok: false, message: "The passkey check didn't pass." }, 401);
    // What to do comes from the signed challenge; the one thing read from this body is a key.
    const { op, service, alias, url, oauth, account } = verified.binding;
    if (typeof alias !== "string")
      return c.json({ ok: false, message: "That change isn't yours to make." }, 409);
    const pasted = stringField(body, "key")?.trim() ?? "";
    const wantsKey =
      op === "rekey" || (op === "connect" && typeof service === "string" && needsKey(service));
    if (wantsKey && (pasted === "" || pasted.length > MAX_KEY_CHARS)) {
      return c.json({ ok: false, message: "Paste the key, then try again. Nothing changed." }, 400);
    }
    const provider = op === "rekey" ? (owned(session, alias)?.provider ?? "") : String(service);
    const checked =
      wantsKey && deps.checkKey !== undefined ? await deps.checkKey(provider, pasted) : null;
    if (checked?.status === "rejected") return c.json({ ok: false, message: checked.message }, 409);
    const isUnchecked = checked?.status === "unchecked";
    try {
      if (op === "connect" && typeof service === "string" && SERVICES.has(service)) {
        if (typeof url === "string") {
          // heel contacts this server only on a public host.
          const unsafe = await publicHostProblem(url, deps.resolveHost ?? resolveAll);
          if (unsafe !== null) return c.json({ ok: false, message: unsafe }, 409);
        }
        connectAccount(
          deps.db,
          deps.upstreamOAuth?.vault ?? null,
          {
            orgId: deps.orgId,
            ownerId: session.userId,
            provider: service,
            alias,
            ...(typeof url === "string" ? { url, oauth: oauth !== "no", publicOnly: true } : {}),
            ...(needsKey(service)
              ? { credential: { type: "static" as const, value: pasted } }
              : {}),
          },
          deps.now(),
        );
        deps.log.warn(
          { account: alias, provider: service, by: session.userId },
          "account connected from the web app",
        );
        return c.json({
          ok: true,
          next: `/connections?note=${accountNotes(deps).add(session.userId, { kind: "added", alias, unchecked: isUnchecked })}`,
        });
      }
      const current = op === "rekey" ? owned(session, alias) : null;
      if (
        op === "rekey" &&
        current !== null &&
        current.id === account &&
        needsKey(current.provider)
      ) {
        const set = setAccountCredential(
          deps.db,
          deps.upstreamOAuth?.vault ?? null,
          deps.orgId,
          alias,
          {
            type: "static",
            value: pasted,
          },
        );
        deps.onAccountConfigured?.(set.accountId);
        deps.log.warn(
          { account: alias, by: session.userId },
          "account key replaced from the web app",
        );
        return c.json({
          ok: true,
          next: `/connections?note=${accountNotes(deps).add(session.userId, { kind: "rekeyed", alias, unchecked: isUnchecked })}`,
        });
      }
    } catch (error) {
      if (error instanceof ConnectError) return c.json({ ok: false, message: error.message }, 409);
      throw error;
    }
    return c.json({ ok: false, message: "That change isn't yours to make." }, 409);
  });

  // Only takes access away: a plain form, no passkey.
  app.post("/connections/:alias/remove", signedIn, requireCsrfField(), (c) => {
    const session = c.get("session");
    const alias = c.req.param("alias");
    if (owned(session, alias) === null)
      return c.text("There's no account of yours by that name.", 404);
    const removed = removeAccount(deps.db, deps.orgId, alias, deps.now());
    deps.onAccountConfigured?.(removed.accountId);
    deps.log.warn({ account: alias, by: session.userId }, "account removed from the web app");
    const note = accountNotes(deps).add(session.userId, {
      kind: "removed",
      alias,
      unchecked: false,
    });
    return c.redirect(`/connections?note=${note}`, 303);
  });

  return app;
}
