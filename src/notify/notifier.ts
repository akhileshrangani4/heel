import { eq } from "drizzle-orm";
import type { Logger } from "../log.ts";
import { findProposal } from "../proposals/rules.ts";
import { getApproval } from "../store/approvals.ts";
import type { HeelDb } from "../store/db.ts";
import {
  type DeliveryRow,
  dueDeliveries,
  enqueueApprovalNotifications,
  enqueueProposalNotifications,
  findPushSubscription,
  removePushSubscription,
  updateDelivery,
} from "../store/notifications.ts";
import { agents, type NotifyChannel } from "../store/schema.ts";
import { errorShape } from "../util/error-shape.ts";
import type { ChannelSender, DeliveryTarget } from "./channels.ts";
import { approvalUrl, type Notice, nextAttemptAfter, proposalUrl } from "./message.ts";

/**
 * Sends notifications (spec: Notifications) from the outbox.
 *
 * When the pipeline creates a pending request it calls `approvalRequested`,
 * which queues one delivery per approver and channel and starts sending at
 * once. A new rule proposal does the same through `ruleProposed`, to the
 * agent's owner (roadmap 2.1). A timer picks up retries. Each delivery ends one of four ways:
 *
 * - sent;
 * - retried with backoff (`RETRY_DELAYS_MS`), then failed after the last try;
 * - dropped, when there's nothing left to tell: the request was decided or
 *   expired, the push subscription is gone, or the channel was turned off.
 *
 * Nothing here can change a request or a proposal. A notification that
 * never arrives leaves it pending and listed on the approval page.
 */

export interface NotifierDeps {
  db: HeelDb;
  orgId: string;
  log: Logger;
  /** The human plane's public URL; every notice links into it. */
  publicUrl: URL;
  /** One sender per configured channel. */
  senders: readonly ChannelSender[];
  now?: () => Date;
  /** How often the timer looks for due retries. Default 5 s. */
  intervalMs?: number;
}

/** How many deliveries one pass sends, so a large backlog can't stall a pass. */
const BATCH = 50;

export class Notifier {
  readonly #deps: NotifierDeps;
  readonly #senders: ReadonlyMap<NotifyChannel, ChannelSender>;
  readonly #now: () => Date;
  #timer: NodeJS.Timeout | null = null;
  #draining: Promise<void> | null = null;

  constructor(deps: NotifierDeps) {
    this.#deps = deps;
    this.#senders = new Map(deps.senders.map((sender) => [sender.channel, sender]));
    this.#now = deps.now ?? (() => new Date());
  }

  /** The channels heel can send on, as configured. */
  get channels(): ReadonlySet<NotifyChannel> {
    return new Set(this.#senders.keys());
  }

  /**
   * The pipeline's `onApprovalRequested`: queues the request's deliveries
   * and starts sending without waiting. Called once per new request, never
   * for a repeat that joins one (I-51).
   */
  approvalRequested(approvalId: string): void {
    const queued = enqueueApprovalNotifications(this.#deps.db, {
      orgId: this.#deps.orgId,
      approvalId,
      channels: this.channels,
      now: this.#now(),
    });
    if (queued === 0) {
      this.#deps.log.warn(
        { approvalId },
        "no notification channel reaches this request's approvers; it waits on the approval page",
      );
      return;
    }
    void this.drain();
  }

  /**
   * The MCP server's `onRuleProposal`: queues the proposal's deliveries to
   * its owner and starts sending without waiting.
   */
  ruleProposed(proposalId: string): void {
    const queued = enqueueProposalNotifications(this.#deps.db, {
      orgId: this.#deps.orgId,
      proposalId,
      channels: this.channels,
      now: this.#now(),
    });
    if (queued === 0) {
      this.#deps.log.warn(
        { proposalId },
        "no notification channel reaches this proposal's owner; it waits on the approval page",
      );
      return;
    }
    void this.drain();
  }

  /** Sends every due delivery. Concurrent calls share one pass. */
  drain(): Promise<void> {
    this.#draining ??= this.#drainOnce().finally(() => {
      this.#draining = null;
    });
    return this.#draining;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.drain(), this.#deps.intervalMs ?? 5_000);
    this.#timer.unref();
  }

  async stop(): Promise<void> {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    await this.#draining;
  }

  async #drainOnce(): Promise<void> {
    for (;;) {
      const batch = dueDeliveries(this.#deps.db, this.#now(), BATCH);
      for (const delivery of batch) {
        try {
          await this.#deliver(delivery);
        } catch (error) {
          // A fault in heel, not the channel: retry like any failed attempt.
          this.#deps.log.error(
            { deliveryId: delivery.id, error: errorShape(error) },
            "notification delivery failed inside heel",
          );
          this.#retry(delivery, "internal");
        }
      }
      if (batch.length < BATCH) return;
    }
  }

  async #deliver(delivery: DeliveryRow): Promise<void> {
    const { db } = this.#deps;
    const notice = this.#noticeFor(delivery);
    if (notice === null) {
      updateDelivery(db, delivery.id, { status: "dropped", reason: "request_settled" });
      return;
    }
    const sender = this.#senders.get(delivery.channel);
    if (sender === undefined) {
      updateDelivery(db, delivery.id, { status: "dropped", reason: "channel_off" });
      return;
    }
    const target = this.#targetOf(delivery);
    if (target === null) {
      updateDelivery(db, delivery.id, { status: "dropped", reason: "subscription_removed" });
      return;
    }

    const outcome = await sender.send(target, notice);
    switch (outcome.kind) {
      case "sent":
        updateDelivery(db, delivery.id, { status: "sent", at: this.#now() });
        return;
      case "gone":
        if (target.channel === "web_push") removePushSubscription(db, delivery.target);
        updateDelivery(db, delivery.id, { status: "dropped", reason: outcome.reason });
        return;
      case "retry":
        this.#deps.log.warn(
          { deliveryId: delivery.id, channel: delivery.channel, reason: outcome.reason },
          "notification not delivered; retrying",
        );
        this.#retry(delivery, outcome.reason);
        return;
    }
  }

  /** What to say about the delivery's subject, or null when it no longer waits. */
  #noticeFor(delivery: DeliveryRow): Notice | null {
    const { db, publicUrl } = this.#deps;
    const now = this.#now();
    if (delivery.proposalId !== null) {
      const proposal = findProposal(db, delivery.orgId, delivery.proposalId);
      if (proposal === null || proposal.status !== "pending" || proposal.expiresAt < now)
        return null;
      const agent = db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, proposal.agentId))
        .get();
      return {
        kind: "proposal",
        agent: agent?.name ?? "An agent",
        rules: proposal.rules.length,
        url: proposalUrl(publicUrl, proposal.id),
      };
    }
    if (delivery.approvalId === null) return null;
    const approval = getApproval(db, delivery.orgId, delivery.approvalId, now);
    if (approval === null || approval.status !== "pending") return null;
    const { row, agentName } = approval;
    return {
      kind: "approval",
      agent: agentName,
      what: row.call.action ?? row.tool,
      account: row.account,
      url: approvalUrl(publicUrl, row.id),
    };
  }

  #targetOf(delivery: DeliveryRow): DeliveryTarget | null {
    if (delivery.channel !== "web_push")
      return { channel: delivery.channel, email: delivery.target };
    const device = findPushSubscription(this.#deps.db, delivery.target);
    if (device === null) return null;
    return {
      channel: "web_push",
      subscription: {
        endpoint: device.endpoint,
        keys: { p256dh: device.p256dh, auth: device.auth },
      },
    };
  }

  #retry(delivery: DeliveryRow, reason: string): void {
    const attempts = delivery.attempts + 1;
    const next = nextAttemptAfter(attempts, this.#now());
    updateDelivery(
      this.#deps.db,
      delivery.id,
      next === null
        ? { status: "failed", attempts, reason }
        : { status: "pending", attempts, nextAttemptAt: next, reason },
    );
  }
}
