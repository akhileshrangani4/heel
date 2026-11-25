import { and, desc, eq, gt, gte, inArray, lt, type SQL, sql } from "drizzle-orm";
import type { AuditKind } from "../core/audit.ts";
import type { HeelDb } from "./db.ts";
import { agents, auditLog, users } from "./schema.ts";

/**
 * What the observability views read from the audit log: the newest
 * rows with filters, a per-agent inventory, and the shadow/record rows that
 * rule suggestions are drawn from. Read-only.
 */

export type ActivityRow = typeof auditLog.$inferSelect;

export interface ActivityQuery {
  orgId: string;
  /** Only these owners' agents; null for everyone (an admin). */
  ownerIds: readonly string[] | null;
  agentId?: string | undefined;
  account?: string | undefined;
  kind?: AuditKind | undefined;
  /** Only one code-mode script's calls (auditLog.scriptId). */
  scriptId?: string | undefined;
  /** Rows with an id below this, for the next page; or above `afterId` for a live stream. */
  beforeId?: number | undefined;
  afterId?: number | undefined;
  limit: number;
}

/** Audit rows, newest first (or oldest first after `afterId`), within what the viewer may see. */
export function readActivity(db: HeelDb, query: ActivityQuery): ActivityRow[] {
  const conditions: SQL[] = [eq(auditLog.orgId, query.orgId)];
  if (query.ownerIds !== null) {
    if (query.ownerIds.length === 0) return [];
    conditions.push(inArray(auditLog.ownerId, [...query.ownerIds]));
  }
  if (query.agentId !== undefined) conditions.push(eq(auditLog.agentId, query.agentId));
  if (query.account !== undefined) conditions.push(eq(auditLog.account, query.account));
  if (query.kind !== undefined) conditions.push(eq(auditLog.kind, query.kind));
  if (query.scriptId !== undefined) conditions.push(eq(auditLog.scriptId, query.scriptId));
  if (query.beforeId !== undefined) conditions.push(lt(auditLog.id, query.beforeId));
  if (query.afterId !== undefined) conditions.push(gt(auditLog.id, query.afterId));
  const order = query.afterId !== undefined ? auditLog.id : desc(auditLog.id);
  return db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(order)
    .limit(query.limit)
    .all();
}

export interface AgentActivity {
  agentId: string;
  name: string;
  owner: string;
  ownerId: string;
  revoked: boolean;
  lastCallAt: Date | null;
  calls: number;
  allowed: number;
  denied: number;
  asked: number;
  /** Shadow/record rows: calls that ran though the rules would have denied or asked. */
  wouldHaveStopped: number;
  accounts: string[];
}

/** Every agent the viewer may see, with what it did since `since`. */
export function agentInventory(
  db: HeelDb,
  input: { orgId: string; ownerIds: readonly string[] | null; since: Date },
): AgentActivity[] {
  const people = new Map(
    db
      .select({ id: users.id, name: users.name })
      .from(users)
      .where(eq(users.orgId, input.orgId))
      .all()
      .map((u) => [u.id, u.name]),
  );
  const list = db
    .select()
    .from(agents)
    .where(eq(agents.orgId, input.orgId))
    .all()
    .filter((a) => input.ownerIds === null || input.ownerIds.includes(a.ownerId));
  const count = (kinds: readonly AuditKind[]) =>
    sql<number>`sum(case when ${auditLog.kind} in (${sql.join(
      kinds.map((k) => sql`${k}`),
      sql`, `,
    )}) then 1 else 0 end)`;
  const stats = db
    .select({
      agentId: auditLog.agentId,
      lastAt: sql<number | null>`max(${auditLog.at})`,
      allowed: count(["allow", "executed"]),
      denied: count(["deny"]),
      asked: count(["ask"]),
      would: count(["would_deny", "would_ask"]),
      accounts: sql<string>`group_concat(distinct ${auditLog.account})`,
    })
    .from(auditLog)
    .where(and(eq(auditLog.orgId, input.orgId), gte(auditLog.at, input.since)))
    .groupBy(auditLog.agentId)
    .all();
  const byAgent = new Map(stats.map((s) => [s.agentId, s]));
  return list.map((a) => {
    const s = byAgent.get(a.id);
    const allowed = Number(s?.allowed ?? 0);
    const denied = Number(s?.denied ?? 0);
    const asked = Number(s?.asked ?? 0);
    const would = Number(s?.would ?? 0);
    return {
      agentId: a.id,
      name: a.name,
      owner: people.get(a.ownerId) ?? "unknown",
      ownerId: a.ownerId,
      revoked: a.revokedAt !== null,
      lastCallAt: s?.lastAt == null ? null : new Date(Number(s.lastAt)),
      calls: allowed + denied + asked + would,
      allowed,
      denied,
      asked,
      wouldHaveStopped: would,
      accounts: (s?.accounts ?? "").split(",").filter((x) => x !== ""),
    };
  });
}

/** The shadow and record rows since `since`: what rules would have stopped. */
export function wouldHaveStopped(
  db: HeelDb,
  input: { orgId: string; ownerIds: readonly string[] | null; since: Date },
): ActivityRow[] {
  const conditions: SQL[] = [
    eq(auditLog.orgId, input.orgId),
    inArray(auditLog.kind, ["would_deny", "would_ask"]),
    gte(auditLog.at, input.since),
    sql`${auditLog.mode} is not null`,
  ];
  if (input.ownerIds !== null) {
    if (input.ownerIds.length === 0) return [];
    conditions.push(inArray(auditLog.ownerId, [...input.ownerIds]));
  }
  return db
    .select()
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(desc(auditLog.id))
    .limit(5_000)
    .all();
}

/** When each named account last had a call decided, for the Connections page. */
export function lastUsedByAccount(
  db: HeelDb,
  orgId: string,
  aliases: readonly string[],
): Map<string, Date> {
  if (aliases.length === 0) return new Map();
  const rows = db
    .select({ account: auditLog.account, lastAt: sql<number | null>`max(${auditLog.at})` })
    .from(auditLog)
    .where(and(eq(auditLog.orgId, orgId), inArray(auditLog.account, [...aliases])))
    .groupBy(auditLog.account)
    .all();
  return new Map(
    rows.flatMap((r) =>
      r.lastAt == null ? [] : [[r.account, new Date(Number(r.lastAt))] as const],
    ),
  );
}

/** Every account name in the audit rows the viewer may see, for the Activity filter. */
export function accountsSeen(
  db: HeelDb,
  input: { orgId: string; ownerIds: readonly string[] | null },
): string[] {
  const conditions: SQL[] = [eq(auditLog.orgId, input.orgId)];
  if (input.ownerIds !== null) {
    if (input.ownerIds.length === 0) return [];
    conditions.push(inArray(auditLog.ownerId, [...input.ownerIds]));
  }
  return db
    .selectDistinct({ account: auditLog.account })
    .from(auditLog)
    .where(and(...conditions))
    .orderBy(auditLog.account)
    .all()
    .map((r) => r.account);
}
