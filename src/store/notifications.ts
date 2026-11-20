import { and, asc, eq, isNull, lte } from "drizzle-orm";
import type { HeelQuery } from "../gateway/pipeline/ports.ts";
import { approverIds } from "./approvals.ts";
import type { HeelDb } from "./db.ts";
import { newId } from "./ids.ts";
import {
  approvals,
  type NotifyChannel,
  notificationDeliveries,
  pushSubscriptions,
  ruleProposals,
  users,
} from "./schema.ts";

/**
 * The notification outbox, push subscriptions and people's email addresses
 * (spec: Notifications). The notifier (src/notify) reads and writes these;
 * nothing here sends anything.
 */

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/** What a delivery tells someone about: a request, or a rule proposal. */
type Subject = { approvalId: string } | { proposalId: string };

/**
 * One delivery per channel and target for each person: web push to every
 * device they turned on, email and Slack to their address when they have
 * one. Disabled people get nothing. Queuing the same subject twice adds
 * nothing. Returns how many were queued.
 */
function enqueueFor(
  db: HeelDb,
  input: { orgId: string; subject: Subject; channels: ReadonlySet<NotifyChannel>; now: Date },
  userIds: Iterable<string>,
): number {
  const rows: (typeof notificationDeliveries.$inferInsert)[] = [];
  const queue = (userId: string, channel: NotifyChannel, target: string) =>
    rows.push({
      id: newId("delivery"),
      orgId: input.orgId,
      ...input.subject,
      userId,
      channel,
      target,
      status: "pending",
      nextAttemptAt: input.now,
      createdAt: input.now,
    });

  for (const userId of userIds) {
    const person = db
      .select({ email: users.email, disabledAt: users.disabledAt })
      .from(users)
      .where(eq(users.id, userId))
      .get();
    if (person === undefined || person.disabledAt !== null) continue;
    if (input.channels.has("web_push")) {
      for (const device of pushSubscriptionsOf(db, userId))
        queue(userId, "web_push", device.endpoint);
    }
    if (person.email !== null) {
      if (input.channels.has("email")) queue(userId, "email", person.email);
      if (input.channels.has("slack")) queue(userId, "slack", person.email);
    }
  }
  if (rows.length === 0) return 0;
  return db.insert(notificationDeliveries).values(rows).onConflictDoNothing().run().changes;
}

/**
 * Queues deliveries for a new request to its approvers: the account's
 * owner, or the admins for an org ask (the same people the approval page
 * lets decide). Returns how many were queued.
 */
export function enqueueApprovalNotifications(
  db: HeelDb,
  input: { orgId: string; approvalId: string; channels: ReadonlySet<NotifyChannel>; now: Date },
): number {
  const approval = db
    .select({
      orgId: approvals.orgId,
      account: approvals.account,
      origin: approvals.origin,
      // The call decides who is asked: per-repo approvers route by its repo.
      call: approvals.call,
    })
    .from(approvals)
    .where(and(eq(approvals.orgId, input.orgId), eq(approvals.id, input.approvalId)))
    .get();
  if (approval === undefined) return 0;
  return enqueueFor(
    db,
    { ...input, subject: { approvalId: input.approvalId } },
    approverIds(db, approval),
  );
}

/**
 * Queues deliveries for a new rule proposal (roadmap 2.1) to the one person
 * who can add it: the proposing agent's owner. Returns how many were queued.
 */
export function enqueueProposalNotifications(
  db: HeelDb,
  input: { orgId: string; proposalId: string; channels: ReadonlySet<NotifyChannel>; now: Date },
): number {
  const proposal = db
    .select({ ownerId: ruleProposals.ownerId })
    .from(ruleProposals)
    .where(and(eq(ruleProposals.orgId, input.orgId), eq(ruleProposals.id, input.proposalId)))
    .get();
  if (proposal === undefined) return 0;
  return enqueueFor(db, { ...input, subject: { proposalId: input.proposalId } }, [
    proposal.ownerId,
  ]);
}

/** Pending deliveries whose time has come, oldest first. */
export function dueDeliveries(db: HeelQuery, now: Date, limit: number): DeliveryRow[] {
  return db
    .select()
    .from(notificationDeliveries)
    .where(
      and(
        eq(notificationDeliveries.status, "pending"),
        lte(notificationDeliveries.nextAttemptAt, now),
      ),
    )
    .orderBy(asc(notificationDeliveries.nextAttemptAt), asc(notificationDeliveries.createdAt))
    .limit(limit)
    .all();
}

/** What became of one attempt; see `Notifier` for how each is reached. */
export type DeliveryUpdate =
  | { status: "sent"; at: Date }
  | { status: "pending"; attempts: number; nextAttemptAt: Date; reason: string }
  | { status: "failed"; attempts: number; reason: string }
  | { status: "dropped"; reason: string };

export function updateDelivery(db: HeelQuery, id: string, update: DeliveryUpdate): void {
  const set: Partial<typeof notificationDeliveries.$inferInsert> = { status: update.status };
  switch (update.status) {
    case "sent":
      set.sentAt = update.at;
      set.lastError = null;
      break;
    case "pending":
      set.attempts = update.attempts;
      set.nextAttemptAt = update.nextAttemptAt;
      set.lastError = update.reason;
      break;
    case "failed":
      set.attempts = update.attempts;
      set.lastError = update.reason;
      break;
    case "dropped":
      set.lastError = update.reason;
      break;
  }
  db.update(notificationDeliveries).set(set).where(eq(notificationDeliveries.id, id)).run();
}

export function deliveriesFor(db: HeelQuery, approvalId: string): DeliveryRow[] {
  return db
    .select()
    .from(notificationDeliveries)
    .where(eq(notificationDeliveries.approvalId, approvalId))
    .orderBy(asc(notificationDeliveries.createdAt), asc(notificationDeliveries.channel))
    .all();
}

// ── push subscriptions ──────────────────────────────────────────────────────

export function pushSubscriptionsOf(db: HeelQuery, userId: string): PushSubscriptionRow[] {
  return db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).all();
}

export function findPushSubscription(db: HeelQuery, endpoint: string): PushSubscriptionRow | null {
  return (
    db.select().from(pushSubscriptions).where(eq(pushSubscriptions.endpoint, endpoint)).get() ??
    null
  );
}

/** How many devices one person may have notifications on; the oldest is dropped past it. */
export const MAX_PUSH_SUBSCRIPTIONS = 10;

/**
 * Stores a device's subscription for a person. A device that subscribes
 * again replaces its keys. An endpoint that already belongs to someone else
 * isn't moved (false): taking it would silence their device. Past
 * MAX_PUSH_SUBSCRIPTIONS the person's oldest devices are dropped.
 */
export function savePushSubscription(
  db: HeelQuery,
  input: {
    orgId: string;
    userId: string;
    endpoint: string;
    p256dh: string;
    auth: string;
    now: Date;
  },
): boolean {
  const existing = findPushSubscription(db, input.endpoint);
  if (existing !== null && existing.userId !== input.userId) return false;
  db.insert(pushSubscriptions)
    .values({
      endpoint: input.endpoint,
      orgId: input.orgId,
      userId: input.userId,
      p256dh: input.p256dh,
      auth: input.auth,
      createdAt: input.now,
    })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { p256dh: input.p256dh, auth: input.auth, createdAt: input.now },
    })
    .run();
  const mine = pushSubscriptionsOf(db, input.userId).sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
  );
  for (const old of mine.slice(MAX_PUSH_SUBSCRIPTIONS)) {
    removePushSubscription(db, old.endpoint, input.userId);
  }
  return true;
}

/** Turns notifications off on every device of a person; how many there were. */
export function removeAllPushSubscriptions(db: HeelQuery, userId: string): number {
  return db.delete(pushSubscriptions).where(eq(pushSubscriptions.userId, userId)).run().changes;
}

/** Removes a subscription; `userId` limits it to that person's own devices when given. */
export function removePushSubscription(db: HeelQuery, endpoint: string, userId?: string): boolean {
  const where =
    userId === undefined
      ? eq(pushSubscriptions.endpoint, endpoint)
      : and(eq(pushSubscriptions.endpoint, endpoint), eq(pushSubscriptions.userId, userId));
  return db.delete(pushSubscriptions).where(where).run().changes === 1;
}

// ── people's addresses ──────────────────────────────────────────────────────

/** Sets or clears where email and Slack notifications reach a person. False when no such user. */
export function setUserEmail(
  db: HeelDb,
  orgId: string,
  name: string,
  email: string | null,
): boolean {
  return (
    db
      .update(users)
      .set({ email })
      .where(and(eq(users.orgId, orgId), eq(users.name, name), isNull(users.disabledAt)))
      .run().changes === 1
  );
}
