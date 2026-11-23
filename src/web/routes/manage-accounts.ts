import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { resolveAll } from "../../definitions/mcp/public-only.ts";
import {
  agentUrlProblem,
  needsKey,
  publicHostProblem,
  REQUESTABLE_SERVICES,
} from "../../requests/connection.ts";
import { accounts, users } from "../../store/schema.ts";
import {
  type Principal,
  SharingError,
  setApprovers,
  shareAccount,
  unshareAccount,
} from "../../store/sharing.ts";
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
import { typedName } from "../typed-name.ts";

/**
 * Accounts from the web app (roadmap 2.9), as `heel connect`, `heel account
 * set` and `heel account remove` do them on the host. Connecting one and
 * replacing its key ask for a passkey; removing one is a plain form, since it
 * only takes access away. People manage the accounts they own.
 *
 * A pasted key is read from the confirm body only, after the passkey, and goes
 * to the vault and nowhere else: not the challenge, a log line, or a redirect.
 * A key the service turns down is never stored.
 *
 * Sharing an account and naming its approvers (D13b, as `heel account share`
 * and `heel account approvers`) also ask for a passkey: both give someone
 * else a say. Owners share; only admins name approvers (spec: Teams), so a
 * member can't remove the reviewer an admin put on their account. Unsharing
 * only takes access away, so it's a plain form.
 */

const MAX_KEY_CHARS = 8_192;

/** The groups an approvers form lists, one per line: a group name may itself hold a comma. */
export function groupLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((g) => g.trim())
    .filter((g) => g !== "");
}
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

  /** An account this person owns, by its id (what a passkey signed). */
  function ownedById(session: SessionView, id: unknown) {
    if (typeof id !== "string") return null;
    return (
      deps.db
        .select({ id: accounts.id, alias: accounts.alias, provider: accounts.provider })
        .from(accounts)
        .where(
          and(
            eq(accounts.orgId, deps.orgId),
            eq(accounts.id, id),
            eq(accounts.ownerId, session.userId),
          ),
        )
        .get() ?? null
    );
  }

  /** Someone else on this heel who can be named, by name; null for anyone else. */
  function personNamed(session: SessionView, name: string) {
    const user = deps.db
      .select({ id: users.id, name: users.name, disabledAt: users.disabledAt })
      .from(users)
      .where(and(eq(users.orgId, deps.orgId), eq(users.name, name)))
      .get();
    return user === undefined || user.disabledAt !== null || user.id === session.userId
      ? null
      : user;
  }

  function personById(id: string) {
    const user = deps.db
      .select({ name: users.name, disabledAt: users.disabledAt })
      .from(users)
      .where(and(eq(users.orgId, deps.orgId), eq(users.id, id)))
      .get();
    return user === undefined || user.disabledAt !== null ? null : user.name;
  }

  /** A group as the IdP sends it, and only where people sign in with one. */
  function groupProblem(name: string): string | null {
    if (deps.oidc == null) return "Groups come from a sign-in provider, and this heel has none.";
    if (name === "" || name.length > 256 || name.trim() !== name) {
      return "A group name is 1 to 256 characters, exactly as your sign-in provider sends it.";
    }
    return null;
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
    const typed = (stringField(body, "alias") ?? "").trim();
    // A new account's name as people type it on a phone ("Gmail work"); existing ones are matched exactly.
    const alias = op === "connect" ? typedName(typed) : typed;
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
    if (op === "share") {
      const account = owned(session, alias);
      if (account === null) return { problem: "There's no account of yours by that name." };
      const kind = stringField(body, "kind") === "group" ? "group" : "user";
      const name = stringField(body, kind === "group" ? "group" : "person") ?? "";
      if (kind === "group") {
        const problem = groupProblem(name);
        if (problem !== null) return { problem };
        return { binding: { op, account: account.id, kind, principal: name } };
      }
      const person = personNamed(session, name);
      if (person === null) return { problem: "Pick someone on this heel to share it with." };
      return { binding: { op, account: account.id, kind, principal: person.id } };
    }
    if (op === "approvers") {
      // Admins assign approvers (spec: Teams): an owner can't clear the reviewer set on their account.
      if (session.role !== "admin")
        return { problem: "Only an admin names an account's approvers." };
      const account = owned(session, alias);
      if (account === null) return { problem: "There's no account of yours by that name." };
      const repo = (stringField(body, "repo") ?? "").trim();
      // The form for a new repo, left empty, must not replace the approvers for every call.
      if (repo === "" && stringField(body, "scope") === "repo")
        return { problem: "Name the repo." };
      if (repo !== "" && account.provider !== "github" && account.provider !== "cli:gh") {
        return { problem: "Approvers for one repo are only for GitHub accounts." };
      }
      if (repo !== "" && !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repo)) {
        return { problem: "A repo is owner/name, like nodejs/node." };
      }
      const approvers: { kind: "user" | "group"; principal: string }[] = [];
      for (const [field, value] of Object.entries(body ?? {})) {
        if (!field.startsWith("user:") || value !== "on") continue;
        const person = personNamed(session, field.slice("user:".length));
        if (person === null) return { problem: "Someone you picked isn't on this heel any more." };
        approvers.push({ kind: "user", principal: person.id });
      }
      const groups = groupLines(stringField(body, "groups") ?? "");
      for (const group of groups) {
        const problem = groupProblem(group);
        if (problem !== null) return { problem };
        approvers.push({ kind: "group", principal: group });
      }
      if (approvers.length > 64) return { problem: "That's more approvers than heel keeps." };
      return {
        binding: { op, account: account.id, repo, approvers: JSON.stringify(approvers) },
      };
    }
    return { problem: "Unknown change." };
  }

  /** Shares an account, or names its approvers, exactly as a passkey signed it. */
  function applySharing(
    session: SessionView,
    binding: Readonly<Record<string, string>>,
  ): { ok: true; alias: string } | { ok: false; message: string } {
    const account = ownedById(session, binding["account"]);
    if (account === null) return { ok: false, message: "That change isn't yours to make." };
    // A person by the id that was signed, still on this heel: never by a name read now.
    const principalOf = (kind: unknown, principal: unknown): Principal | null => {
      if (typeof principal !== "string") return null;
      if (kind === "group")
        return groupProblem(principal) === null ? { kind, name: principal } : null;
      if (kind !== "user" || principal === session.userId) return null;
      const name = personById(principal);
      return name === null ? null : { kind, name };
    };
    if (binding["op"] === "share") {
      const principal = principalOf(binding["kind"], binding["principal"]);
      if (principal === null)
        return { ok: false, message: "That person isn't on this heel any more." };
      shareAccount(deps.db, deps.orgId, account.alias, principal, deps.now());
      return { ok: true, alias: account.alias };
    }
    let listed: unknown;
    try {
      listed = JSON.parse(binding["approvers"] ?? "");
    } catch {
      listed = null;
    }
    if (!Array.isArray(listed)) return { ok: false, message: "That change isn't yours to make." };
    const approvers: Principal[] = [];
    for (const entry of listed as { kind?: unknown; principal?: unknown }[]) {
      const principal = principalOf(entry?.kind, entry?.principal);
      if (principal === null) {
        return { ok: false, message: "Someone you picked isn't on this heel any more." };
      }
      approvers.push(principal);
    }
    // Checked again now: a role can change between the prompt and the tap.
    if (session.role !== "admin") return { ok: false, message: "That change isn't yours to make." };
    const repo = binding["repo"] === "" ? null : (binding["repo"] ?? null);
    setApprovers(deps.db, deps.orgId, account.alias, repo, approvers, deps.now());
    return { ok: true, alias: account.alias };
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
    if (op === "share" || op === "approvers") {
      try {
        const done = applySharing(session, verified.binding);
        if (!done.ok) return c.json({ ok: false, message: done.message }, 409);
        deps.log.warn(
          { account: done.alias, op, by: session.userId },
          "account sharing changed from the web app",
        );
        return c.json({
          ok: true,
          next: `/connections?note=${accountNotes(deps).add(session.userId, { kind: "sharing", alias: done.alias, unchecked: false })}`,
        });
      } catch (error) {
        if (error instanceof SharingError)
          return c.json({ ok: false, message: error.message }, 409);
        throw error;
      }
    }
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

  // Only takes access away: a plain form, no passkey.
  app.post("/connections/:alias/unshare", signedIn, requireCsrfField(), async (c) => {
    const session = c.get("session");
    const alias = c.req.param("alias");
    if (owned(session, alias) === null)
      return c.text("There's no account of yours by that name.", 404);
    const form = await c.req.parseBody();
    const kind = form["kind"] === "group" ? "group" : "user";
    const name = typeof form["name"] === "string" ? form["name"] : "";
    try {
      unshareAccount(deps.db, deps.orgId, alias, { kind, name });
    } catch (error) {
      if (error instanceof SharingError) return c.text(error.message, 400);
      throw error;
    }
    deps.log.warn({ account: alias, by: session.userId }, "account unshared from the web app");
    const note = accountNotes(deps).add(session.userId, {
      kind: "sharing",
      alias,
      unchecked: false,
    });
    return c.redirect(`/connections?note=${note}`, 303);
  });

  return app;
}
