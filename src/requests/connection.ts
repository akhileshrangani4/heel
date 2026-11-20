import { and, count, desc, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { publicHostProblem, publicUrlProblem } from "../definitions/mcp/public-only.ts";
import type { HeelDb } from "../store/db.ts";
import { newId } from "../store/ids.ts";
import { agentRequests, agents, type ConnectionRequestDetails, users } from "../store/schema.ts";

/**
 * Connection requests (roadmap 2.5): an agent asks its owner to connect an
 * account, and the owner does it, with a passkey, on heel's page.
 *
 * - The agent can ask only for what needs no secret from it: a built-in
 *   service people sign in to (Gmail, Google Calendar, Outlook), or a remote
 *   MCP server by its https URL. Nothing that runs a program, takes an
 *   OpenAPI file or names where a credential goes.
 * - Asking creates nothing and contacts nothing. No account row exists and
 *   the agent's URL isn't fetched until the owner approves.
 * - The account is always the agent's owner's. What the owner has already
 *   connected never goes back to the agent: a name that's taken is decided
 *   on the owner's page, not in the agent's answer.
 *
 * Rows are never changed once decided, so they are the history too.
 */

/** How long a request waits for its owner. */
export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Requests one agent can have waiting at once; each one notifies its owner. */
export const MAX_PENDING_PER_AGENT = 5;
/** Requests one agent can make in an hour, replaced ones included, so it can't flood its owner. */
export const MAX_PER_HOUR = 10;
const MAX_WHY_CHARS = 200;

/** Built-in services an agent may ask for: each signs in on heel's page, so no secret passes the agent. */
export const REQUESTABLE_SERVICES = ["gmail", "google-calendar", "outlook"] as const;

/** Same rule as `heel connect`: a letter first, then lower-case letters, digits or '-'. */
const ALIAS = /^[a-z][a-z0-9-]{0,63}$/;

/** What `heel_request_connection` takes. */
export const RequestConnectionInput = z
  .strictObject({
    service: z.enum([...REQUESTABLE_SERVICES, "mcp"]),
    alias: z
      .string()
      .regex(ALIAS, "1–64 lower-case letters, digits or '-', starting with a letter"),
    url: z.string().max(2_048).optional(),
    /** For `mcp`: whether the server wants OAuth sign-in. Defaults to yes. */
    oauth: z.boolean().optional(),
    why: z.string().max(2_000).optional(),
  })
  .superRefine((input, ctx) => {
    if (input.service === "mcp") {
      const problem =
        input.url === undefined ? "mcp needs the server's url" : agentUrlProblem(input.url);
      if (problem !== null) ctx.addIssue({ code: "custom", path: ["url"], message: problem });
    } else if (input.url !== undefined || input.oauth !== undefined) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "url and oauth are only for mcp" });
    }
  });
export type RequestConnectionInput = z.input<typeof RequestConnectionInput>;

/**
 * Pure: an MCP server URL an agent may name: https on a public host name.
 * Stricter than `heel connect`, so an agent can't use heel's place on the
 * network. Approving checks again what the name resolves to.
 */
export const agentUrlProblem = publicUrlProblem;

export { publicHostProblem };

/** One line of the agent's text, with no line breaks or control characters, capped. */
function oneLine(text: string | undefined, max: number): string | null {
  if (text === undefined) return null;
  // Control characters, line breaks, and the bidi controls that could make the
  // agent's words read as something else on the page.
  const flat = text
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]+/g, " ")
    .trim();
  return flat === "" ? null : flat.slice(0, max);
}

export type RequestOutcome =
  | { ok: true; requestId: string; expiresAt: Date }
  | { ok: false; problem: string };

/**
 * Stores a request for the agent's owner. An earlier waiting request from
 * the same agent for the same name is replaced. Nothing else is looked at,
 * so the answer says nothing about the owner's accounts.
 */
export function requestConnection(
  db: HeelDb,
  who: { orgId: string; ownerId: string; agentId: string },
  input: z.output<typeof RequestConnectionInput>,
  now: Date,
): RequestOutcome {
  expireRequests(db, now);
  const details: ConnectionRequestDetails =
    input.service === "mcp"
      ? {
          provider: "mcp",
          alias: input.alias,
          // Stored as heel reads it, so the page shows exactly what heel will contact.
          url: new URL(input.url ?? "").href,
          oauth: input.oauth ?? true,
        }
      : { provider: input.service, alias: input.alias };
  const id = newId("agentRequest");
  const expiresAt = new Date(now.getTime() + REQUEST_TTL_MS);
  return db.transaction((tx) => {
    const waiting = tx
      .select({ id: agentRequests.id, details: agentRequests.details })
      .from(agentRequests)
      .where(and(eq(agentRequests.agentId, who.agentId), eq(agentRequests.status, "pending")))
      .all();
    const lastHour =
      tx
        .select({ n: count() })
        .from(agentRequests)
        .where(
          and(
            eq(agentRequests.agentId, who.agentId),
            gt(agentRequests.createdAt, new Date(now.getTime() - 60 * 60 * 1000)),
          ),
        )
        .get()?.n ?? 0;
    if (lastHour >= MAX_PER_HOUR) {
      return {
        ok: false as const,
        problem: `you've asked ${MAX_PER_HOUR} times in the last hour; wait for your owner`,
      };
    }
    const replaced = waiting.filter((r) => r.details.alias === details.alias).map((r) => r.id);
    if (waiting.length - replaced.length >= MAX_PENDING_PER_AGENT) {
      return {
        ok: false as const,
        problem: `you already have ${MAX_PENDING_PER_AGENT} requests waiting for your owner; wait for them to decide`,
      };
    }
    for (const old of replaced) {
      tx.update(agentRequests)
        .set({ status: "superseded", decidedAt: now })
        .where(eq(agentRequests.id, old))
        .run();
    }
    tx.insert(agentRequests)
      .values({
        id,
        orgId: who.orgId,
        ownerId: who.ownerId,
        agentId: who.agentId,
        kind: "connection",
        details,
        why: oneLine(input.why, MAX_WHY_CHARS),
        status: "pending",
        createdAt: now,
        expiresAt,
      })
      .run();
    return { ok: true as const, requestId: id, expiresAt };
  });
}

export type RequestRow = typeof agentRequests.$inferSelect;

/** Marks waiting requests past their time as expired. */
export function expireRequests(db: HeelDb, now: Date): void {
  db.update(agentRequests)
    .set({ status: "expired", decidedAt: now })
    .where(and(eq(agentRequests.status, "pending"), lt(agentRequests.expiresAt, now)))
    .run();
}

/** An owner's waiting requests, newest first. */
export function pendingRequests(db: HeelDb, ownerId: string, now: Date): RequestRow[] {
  expireRequests(db, now);
  return db
    .select()
    .from(agentRequests)
    .where(and(eq(agentRequests.ownerId, ownerId), eq(agentRequests.status, "pending")))
    .orderBy(desc(agentRequests.createdAt))
    .all();
}

/** How many requests an owner has waiting; for the Approvals count. */
export function pendingRequestCount(db: HeelDb, ownerId: string, now: Date): number {
  expireRequests(db, now);
  return (
    db
      .select({ n: count() })
      .from(agentRequests)
      .where(and(eq(agentRequests.ownerId, ownerId), eq(agentRequests.status, "pending")))
      .get()?.n ?? 0
  );
}

/** Every waiting request in the org with its agent's and owner's names, newest first. */
export function orgPendingRequests(
  db: HeelDb,
  orgId: string,
  now: Date,
): { row: RequestRow; agentName: string; ownerName: string }[] {
  expireRequests(db, now);
  return db
    .select({ row: agentRequests, agentName: agents.name, ownerName: users.name })
    .from(agentRequests)
    .innerJoin(agents, eq(agents.id, agentRequests.agentId))
    .innerJoin(users, eq(users.id, agentRequests.ownerId))
    .where(and(eq(agentRequests.orgId, orgId), eq(agentRequests.status, "pending")))
    .orderBy(desc(agentRequests.createdAt))
    .all();
}

export function findRequest(db: HeelDb, orgId: string, id: string): RequestRow | null {
  return (
    db
      .select()
      .from(agentRequests)
      .where(and(eq(agentRequests.orgId, orgId), eq(agentRequests.id, id)))
      .get() ?? null
  );
}

/** Rejecting only keeps things as they are, so it needs no passkey. */
export function rejectRequest(db: HeelDb, row: RequestRow, by: string, now: Date): boolean {
  if (row.status !== "pending") return false;
  return (
    db
      .update(agentRequests)
      .set({ status: "rejected", decidedBy: by, decidedAt: now })
      .where(and(eq(agentRequests.id, row.id), eq(agentRequests.status, "pending")))
      .run().changes === 1
  );
}

/**
 * Approves a waiting request and makes its account, all or nothing: one
 * transaction claims the request (only if it still waits and hasn't
 * expired, so one rejected, replaced or expired a moment ago can't be
 * approved), makes the account and records it. If making it fails, nothing
 * changed and the request still waits.
 */
export function approveRequest(
  db: HeelDb,
  row: RequestRow,
  by: string,
  now: Date,
  connect: () => string,
): { ok: true; accountId: string } | { ok: false; problem: string } {
  return db.transaction((tx) => {
    const claimed =
      tx
        .update(agentRequests)
        .set({ status: "approved", decidedBy: by, decidedAt: now })
        .where(
          and(
            eq(agentRequests.id, row.id),
            eq(agentRequests.status, "pending"),
            gt(agentRequests.expiresAt, now),
          ),
        )
        .run().changes === 1;
    if (!claimed) return { ok: false as const, problem: "That request isn't waiting for you." };
    // `connect` writes through heel's db; better-sqlite3 nests its transaction as a savepoint.
    const accountId = connect();
    tx.update(agentRequests).set({ accountId }).where(eq(agentRequests.id, row.id)).run();
    return { ok: true as const, accountId };
  });
}

/** Pure: heel's own name for what is asked for. */
export function serviceLabel(details: ConnectionRequestDetails): string {
  switch (details.provider) {
    case "gmail":
      return "Gmail";
    case "google-calendar":
      return "Google Calendar";
    case "outlook":
      return "Outlook";
    case "mcp":
      return details.url === undefined || !URL.canParse(details.url)
        ? "an MCP server"
        : `the MCP server at ${new URL(details.url).host}`;
    default:
      return details.provider;
  }
}
