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
  users,
} from "./schema.ts";

/**
 * The notification outbox, push subscriptions and people's email addresses
 * (spec: Notifications). The notifier (src/notify) reads and writes these;
 * nothing here sends anything.
 */

export type DeliveryRow = typeof notificationDeliveries.$inferSelect;
export type PushSubscriptionRow = typeof pushSubscriptions.$inferSelect;

/**
 * Queues one delivery per approver, channel and target for a new request.
 * Approvers are the account's owner, or the admins for an org ask (the same
 * people the approval page lets decide). Web push goes to every device a
 * person turned on; email and Slack go to their address, when they have one.
 * Queuing the same request twice adds nothing. Returns how many were queued.
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

  const rows: (typeof notificationDeliveries.$inferInsert)[] = [];
  const queue = (userId: string, channel: NotifyChannel, target: string) =>
    rows.push({
      id: newId("delivery"),
      orgId: input.orgId,
      approvalId: input.approvalId,
      userId,
      channel,
      target,
      status: "pending",
      nextAttemptAt: input.now,
      createdAt: input.now,
    });

  for (const userId of approverIds(db, approval)) {
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

/** Stores a device's subscription for a person. A device that subscribes again replaces its keys. */
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
): void {
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
      set: { userId: input.userId, p256dh: input.p256dh, auth: input.auth, createdAt: input.now },
    })
    .run();
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
