import { and, eq, gte, inArray, type SQL, sql } from "drizzle-orm";
import { Hono } from "hono";
import { rulesFor } from "../../core/rules/evaluate.ts";
import { listAgents, TOKEN_WARNING_DAYS } from "../../gateway/agents.ts";
import { agentInventory, readActivity, wouldHaveStopped } from "../../store/activity.ts";
import { listApprovalsFor } from "../../store/approvals.ts";
import { accountsOwnedBy } from "../../store/directory.ts";
import { pushSubscriptionsOf } from "../../store/notifications.ts";
import { auditLog, passkeys } from "../../store/schema.ts";
import {
  type HumanPlaneDeps,
  renderPage,
  requireSession,
  type SignedInEnv,
  viewerOf,
} from "../http.ts";
import type { SessionView } from "../sessions.ts";
import { type DayCount, homePage, type RecentRow } from "../ui/home.ts";
import { waitingCounts, waitingItems } from "../waiting.ts";

/**
 * `GET /`: the Home dashboard. What needs you across Approvals, Agents,
 * Connections and Rules, a setup checklist while setup isn't done, the last
 * week's calls and the latest decisions. Read-only; every number links to
 * the page where it can be acted on, and members see only their own agents.
 */

const DAY_MS = 24 * 60 * 60_000;
const WEEK_MS = 7 * DAY_MS;
/** Kinds that record a call's first decision, so one call counts once. */
const CALL_KINDS = [
  "allow",
  "deny",
  "ask",
  "paused",
  "would_allow",
  "would_deny",
  "would_ask",
] as const;

function visibleOwners(session: SessionView): string[] | null {
  return session.role === "admin" ? null : [session.userId];
}

/** Calls per UTC day for the last seven days, oldest first, with allowed/denied/asked totals. */
function callsByDay(
  deps: HumanPlaneDeps,
  ownerIds: readonly string[] | null,
  now: Date,
): DayCount[] {
  const today = Math.floor(now.getTime() / DAY_MS);
  const since = new Date((today - 6) * DAY_MS);
  const days: DayCount[] = Array.from({ length: 7 }, (_, i) => ({
    day: new Date((today - 6 + i) * DAY_MS),
    calls: 0,
    allowed: 0,
    denied: 0,
    asked: 0,
  }));
  if (ownerIds !== null && ownerIds.length === 0) return days;
  const conditions: SQL[] = [
    eq(auditLog.orgId, deps.orgId),
    gte(auditLog.at, since),
    inArray(auditLog.kind, [...CALL_KINDS]),
  ];
  if (ownerIds !== null) conditions.push(inArray(auditLog.ownerId, [...ownerIds]));
  const rows = deps.db
    .select({
      day: sql<number>`cast(${auditLog.at} / ${DAY_MS} as integer)`,
      kind: auditLog.kind,
      n: sql<number>`count(*)`,
    })
    .from(auditLog)
    .where(and(...conditions))
    .groupBy(sql`1`, auditLog.kind)
    .all();
  for (const row of rows) {
    const slot = days[Number(row.day) - (today - 6)];
    if (slot === undefined) continue;
    const n = Number(row.n);
    slot.calls += n;
    if (row.kind === "allow") slot.allowed += n;
    else if (row.kind === "deny") slot.denied += n;
    else if (row.kind === "ask") slot.asked += n;
  }
  return days;
}

export function homeRoutes(deps: HumanPlaneDeps): Hono<SignedInEnv> {
  const app = new Hono<SignedInEnv>();
  const signedIn = requireSession(deps);

  app.get("/", signedIn, (c) => {
    const session = c.get("session");
    const now = deps.now();
    const owners = visibleOwners(session);

    const approvals = listApprovalsFor(deps.db, session, now);
    const counts = waitingCounts(deps, session, now);
    const decided = approvals.filter(
      (r) => r.status === "approved" || r.status === "denied" || r.status === "executed",
    ).length;

    const inventory = agentInventory(deps.db, {
      orgId: deps.orgId,
      ownerIds: owners,
      since: new Date(now.getTime() - WEEK_MS),
    });
    const agents = inventory.filter((a) => !a.revoked);
    const visible = new Set(agents.map((a) => a.agentId));
    const expiring = listAgents(deps.db, deps.orgId).filter(
      (a) =>
        visible.has(a.id) &&
        a.tokenExpiresAt !== null &&
        a.tokenExpiresAt.getTime() - now.getTime() <= TOKEN_WARNING_DAYS * DAY_MS,
    ).length;

    const accounts = accountsOwnedBy(deps.db, session.orgId, session.userId);
    const needsSignIn = accounts.filter((a) => a.status !== "active").length;

    const set = deps.rules.set;
    const stopped = wouldHaveStopped(deps.db, {
      orgId: deps.orgId,
      ownerIds: owners,
      since: new Date(now.getTime() - WEEK_MS),
    }).length;

    const names = new Map(inventory.map((a) => [a.agentId, a.name]));
    const recent: RecentRow[] = readActivity(deps.db, {
      orgId: deps.orgId,
      ownerIds: owners,
      limit: 5,
    }).map((row) => ({
      at: row.at,
      agent: names.get(row.agentId) ?? "An agent",
      kind: row.kind,
      action: row.action,
      tool: row.tool,
      account: row.account,
    }));

    const hasPasskey =
      deps.db
        .select({ id: passkeys.id })
        .from(passkeys)
        .where(eq(passkeys.userId, session.userId))
        .get() !== undefined;

    return renderPage(c, {
      title: "Home",
      viewer: viewerOf(session),
      current: "home",
      body: homePage({
        now,
        approvals: { decided },
        waiting: { counts, items: waitingItems(deps, session, now) },
        agents: {
          total: agents.length,
          active: agents.filter((a) => a.lastCallAt !== null).length,
          expiring,
        },
        connections: { total: accounts.length, needsSignIn },
        rules:
          set === null
            ? { loaded: false, count: 0, stopped }
            : { loaded: true, count: rulesFor(set, session.userId).length, stopped },
        setup: {
          passkey: hasPasskey,
          notifications: pushSubscriptionsOf(deps.db, session.userId).length > 0,
          account: accounts.length > 0,
          agent: agents.length > 0,
        },
        days: callsByDay(deps, owners, now),
        recent,
      }),
    });
  });

  return app;
}
