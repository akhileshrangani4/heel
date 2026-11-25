import { and, eq } from "drizzle-orm";
import type { Call, PauseScope } from "../core/call.ts";
import type { HeelDb } from "../store/db.ts";
import {
  ADMIN_SOCKET_ACTOR,
  broadestScope,
  coveringPauses,
  type PauseKey,
  type PauseRow,
} from "../store/pauses.ts";
import { accounts, agents, users } from "../store/schema.ts";
import type { SessionView } from "./sessions.ts";
import type { PauseNotice } from "./ui/layout.ts";

/**
 * Pauses as people see them on the page. The store keys an agent or owner
 * pause by id; the page shows and posts names. This module translates
 * between the two, and decides who may pause or resume what.
 *
 * Who may do what:
 * - an admin may pause and resume anything;
 * - a member may pause their own agents, their own accounts and themselves
 *   (owner scope), and may resume only a pause they made themselves, so a
 *   member can't lift a pause an admin put on their agent.
 */

/** The store key for a pause the page names; null when the name doesn't exist. */
export function pauseKeyByName(
  db: HeelDb,
  orgId: string,
  scope: PauseScope,
  name: string,
): PauseKey | null {
  switch (scope) {
    case "global":
      return { scope, target: "" };
    case "provider":
      return name === "" ? null : { scope, target: name };
    case "account": {
      const row = db
        .select({ alias: accounts.alias })
        .from(accounts)
        .where(and(eq(accounts.orgId, orgId), eq(accounts.alias, name)))
        .get();
      return row === undefined ? null : { scope, target: row.alias };
    }
    case "agent": {
      const row = db
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.orgId, orgId), eq(agents.name, name)))
        .get();
      return row === undefined ? null : { scope, target: row.id };
    }
    case "owner": {
      const row = db
        .select({ id: users.id })
        .from(users)
        .where(and(eq(users.orgId, orgId), eq(users.name, name)))
        .get();
      return row === undefined ? null : { scope, target: row.id };
    }
  }
}

/** The name the page shows for a pause's target; null for a global pause. */
export function pauseTargetName(db: HeelDb, key: PauseKey): string | null {
  switch (key.scope) {
    case "global":
      return null;
    case "account":
    case "provider":
      return key.target;
    case "agent":
      return (
        db.select({ name: agents.name }).from(agents).where(eq(agents.id, key.target)).get()
          ?.name ?? key.target
      );
    case "owner":
      return (
        db.select({ name: users.name }).from(users).where(eq(users.id, key.target)).get()?.name ??
        key.target
      );
  }
}

/** Who paused, as the page shows it: a person's name, or the admin socket. */
export function pausedByName(db: HeelDb, pausedBy: string): string {
  if (pausedBy === ADMIN_SOCKET_ACTOR) return "the admin socket";
  return (
    db.select({ name: users.name }).from(users).where(eq(users.id, pausedBy)).get()?.name ??
    pausedBy
  );
}

/** The broadest pause covering a call, as the banner and approval page show it. */
export function pauseNoticeFor(db: HeelDb, call: Call): PauseNotice | null {
  const rows = coveringPauses(db, {
    orgId: call.orgId,
    agentId: call.agentId,
    ownerId: call.ownerId,
    account: call.account,
    provider: call.provider,
  });
  const scope = broadestScope(rows.map((row) => row.scope));
  const row = rows.find((r) => r.scope === scope);
  return row === undefined ? null : noticeOf(db, row);
}

export function noticeOf(db: HeelDb, row: PauseRow): PauseNotice {
  return { scope: row.scope, target: pauseTargetName(db, row), since: row.pausedAt };
}

export function mayPause(db: HeelDb, session: SessionView, key: PauseKey): boolean {
  if (session.role === "admin") return true;
  switch (key.scope) {
    case "global":
    case "provider":
      return false;
    case "owner":
      return key.target === session.userId;
    case "agent":
      return (
        db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, key.target)).get()
          ?.ownerId === session.userId
      );
    case "account":
      return (
        db
          .select({ ownerId: accounts.ownerId })
          .from(accounts)
          .where(and(eq(accounts.orgId, session.orgId), eq(accounts.alias, key.target)))
          .get()?.ownerId === session.userId
      );
  }
}

export function mayResume(db: HeelDb, session: SessionView, row: PauseRow): boolean {
  if (session.role === "admin") return true;
  return row.pausedBy === session.userId && mayPause(db, session, row);
}

/** The agents and accounts this person may pause, by name, for the pause page. */
export function pausableTargets(
  db: HeelDb,
  session: SessionView,
): { agents: string[]; accounts: string[] } {
  const own = session.role === "admin" ? undefined : session.userId;
  const agentRows = db
    .select({ name: agents.name, ownerId: agents.ownerId })
    .from(agents)
    .where(eq(agents.orgId, session.orgId))
    .all();
  const accountRows = db
    .select({ alias: accounts.alias, ownerId: accounts.ownerId })
    .from(accounts)
    .where(eq(accounts.orgId, session.orgId))
    .all();
  return {
    agents: agentRows.filter((a) => own === undefined || a.ownerId === own).map((a) => a.name),
    accounts: accountRows.filter((a) => own === undefined || a.ownerId === own).map((a) => a.alias),
  };
}
