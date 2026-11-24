import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import { pendingProposals } from "../proposals/rules.ts";
import { pendingRequests, serviceLabel } from "../requests/connection.ts";
import { listApprovalsFor } from "../store/approvals.ts";
import type { HeelDb } from "../store/db.ts";
import { agents } from "../store/schema.ts";
import { pendingRecoveries } from "./passkeys.ts";
import type { SessionView } from "./sessions.ts";
import type { WaitingItem } from "./ui/home.ts";
import { emailPreviewFrom, headline, httpPreviewFrom, mergePreviewFrom } from "./ui/summary.ts";

/**
 * What is waiting for this person, across heel: calls to approve, accounts
 * an agent asked to connect, rule changes an agent proposed, and recovery
 * links that are live. One number for the menu badge, the page title, the
 * favicon dot, the banner and Home, so they never disagree.
 *
 * The count carries no call arguments, names or ids: it is safe for the
 * title bar and for the poll endpoint (`GET /waiting`).
 */

export interface WaitingCounts {
  calls: number;
  requests: number;
  proposals: number;
  recoveries: number;
  total: number;
}

interface Source {
  db: HeelDb;
  orgId: string;
}

/** Recovery links the person may see: their own, or every one for an admin (as on Approvals). */
function recoveriesFor(src: Source, session: SessionView, now: Date) {
  return pendingRecoveries(src.db, src.orgId, now).filter(
    (r) => r.userId === session.userId || session.role === "admin",
  );
}

function pendingCalls(src: Source, session: SessionView, now: Date) {
  return listApprovalsFor(src.db, session, now).filter((r) => r.status === "pending");
}

export function waitingCounts(src: Source, session: SessionView, now: Date): WaitingCounts {
  const calls = pendingCalls(src, session, now).length;
  const requests = pendingRequests(src.db, session.userId, now).length;
  const proposals = pendingProposals(src.db, session.userId, now).length;
  const recoveries = recoveriesFor(src, session, now).length;
  return {
    calls,
    requests,
    proposals,
    recoveries,
    total: calls + requests + proposals + recoveries,
  };
}

/**
 * The count, and a short opaque version that changes whenever the set of
 * waiting things changes (one decided elsewhere and another arrived keeps
 * the count but not the version). A hash of ids: no names, no arguments.
 */
export function waitingVersion(
  src: Source,
  session: SessionView,
  now: Date,
): { waiting: number; version: string } {
  const ids = [
    ...pendingCalls(src, session, now).map((r) => `c:${r.row.id}`),
    ...pendingRequests(src.db, session.userId, now).map((r) => `r:${r.id}`),
    ...pendingProposals(src.db, session.userId, now).map((r) => `p:${r.id}`),
    ...recoveriesFor(src, session, now).map((r) => `e:${r.id}`),
  ].sort();
  const version = createHash("sha256").update(ids.join("\n")).digest("hex").slice(0, 16);
  return { waiting: ids.length, version };
}

function agentName(db: HeelDb, id: string): string {
  return (
    db.select({ name: agents.name }).from(agents).where(eq(agents.id, id)).get()?.name ?? "An agent"
  );
}

/**
 * Everything waiting, as Home lists it: calls first (an agent is blocked on
 * each), then connection requests, rule changes and recovery links, newest
 * first within each. Every item is a link to the page where it is decided.
 */
export function waitingItems(src: Source, session: SessionView, now: Date): WaitingItem[] {
  const calls: WaitingItem[] = pendingCalls(src, session, now).map(({ row, agentName: agent }) => ({
    kind: "call",
    href: `/approvals/${encodeURIComponent(row.id)}`,
    at: row.createdAt,
    expiresAt: row.expiresAt,
    service: { action: row.call.action ?? null, tool: row.tool, account: row.account },
    headline: headline({
      agent,
      action: row.call.action ?? null,
      tool: row.tool,
      account: row.account,
      email: emailPreviewFrom(row.call.action ?? null, row.call.args),
      merge: mergePreviewFrom(row.call.action ?? null, row.call.args),
      http: httpPreviewFrom(row.call),
    }),
  }));
  const requests: WaitingItem[] = pendingRequests(src.db, session.userId, now).map((row) => ({
    kind: "connection",
    href: `/requests/${encodeURIComponent(row.id)}`,
    at: row.createdAt,
    expiresAt: row.expiresAt,
    agent: agentName(src.db, row.agentId),
    service: serviceLabel(row.details),
    provider: row.details.provider,
  }));
  const proposals: WaitingItem[] = pendingProposals(src.db, session.userId, now).map((row) => ({
    kind: "rules",
    href: `/proposals/${encodeURIComponent(row.id)}`,
    at: row.createdAt,
    expiresAt: row.expiresAt,
    agent: row.origin === "heel" ? "heel" : agentName(src.db, row.agentId),
    changes: row.rules.length + row.hide.length + row.workdirs.length,
  }));
  const recoveries: WaitingItem[] = recoveriesFor(src, session, now).map((r) => ({
    kind: "recovery",
    href: "/approvals",
    at: r.createdAt,
    expiresAt: null,
    user: r.userName,
  }));
  return [...calls, ...requests, ...proposals, ...recoveries];
}
