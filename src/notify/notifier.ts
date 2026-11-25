import { eq } from "drizzle-orm";
import type { Logger } from "../log.ts";
import { findProposal } from "../proposals/rules.ts";
import { findRequest, serviceLabel } from "../requests/connection.ts";
import { getApproval } from "../store/approvals.ts";
import type { HeelDb } from "../store/db.ts";
import {
  type DeliveryRow,
  dueDeliveries,
  enqueueApprovalNotifications,
  enqueueProposalNotifications,
  enqueueRequestNotifications,
  findPushSubscription,
  removePushSubscription,
  updateDelivery,
} from "../store/notifications.ts";
import { agents, type NotifyChannel } from "../store/schema.ts";
import { errorShape } from "../util/error-shape.ts";
import type { ChannelSender, DeliveryTarget } from "./channels.ts";
import { approvalUrl, type Notice, nextAttemptAfter, proposalUrl, requestUrl } from "./message.ts";

/**
 * Sends notifications from the outbox.
 *
 * When the pipeline creates a pending request it calls `approvalRequested`,
 * which queues one delivery per approver and channel and starts sending at
 * once. A new rule proposal does the same through `ruleProposed`, to the
 * agent's owner. A timer picks up retries. Each delivery ends one of four ways:
 *
 * - sent;
 * - retried with backoff (`RETRY_DELAYS_MS`), then failed after the last try;
 * - dropped, when there's nothing left to tell: the request was decided or
 *   expired, the push subscription is gone, or the channel was turned off.
 *
 * Each outcome is logged with the delivery's id, channel and subject, never
 * its target or what it said.
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

  /**
   * The MCP server's `onAgentRequest`: queues the request's deliveries to
   * its owner and starts sending without waiting.
   */
  agentRequested(requestId: string): void {
    const queued = enqueueRequestNotifications(this.#deps.db, {
      orgId: this.#deps.orgId,
      requestId,
      channels: this.channels,
      now: this.#now(),
    });
    if (queued === 0) {
      this.#deps.log.warn(
        { requestId },
        "no notification channel reaches this request's owner; it waits on the approval page",
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
    const { db, log } = this.#deps;
    const notice = this.#noticeFor(delivery);
    if (notice === null) return this.#drop(delivery, "request_settled");
    const sender = this.#senders.get(delivery.channel);
    if (sender === undefined) return this.#drop(delivery, "channel_off");
    const target = this.#targetOf(delivery);
    if (target === null) return this.#drop(delivery, "subscription_removed");

    const outcome = await sender.send(target, notice);
    switch (outcome.kind) {
      case "sent":
        updateDelivery(db, delivery.id, { status: "sent", at: this.#now() });
        log.info(logFields(delivery), "notification sent");
        return;
      case "gone":
        if (target.channel === "web_push") removePushSubscription(db, delivery.target);
        this.#drop(delivery, outcome.reason);
        return;
      case "retry":
        log.warn(
          { ...logFields(delivery), reason: outcome.reason },
          "notification not delivered; retrying",
        );
        this.#retry(delivery, outcome.reason);
        return;
    }
  }

  /** Stops trying a delivery that has nothing left to tell, and says why in the log. */
  #drop(delivery: DeliveryRow, reason: string): void {
    updateDelivery(this.#deps.db, delivery.id, { status: "dropped", reason });
    this.#deps.log.warn({ ...logFields(delivery), reason }, "notification dropped");
  }

  /** What to say about the delivery's subject, or null when it no longer waits. */
  #noticeFor(delivery: DeliveryRow): Notice | null {
    const { db, publicUrl } = this.#deps;
    const now = this.#now();
    if (delivery.requestId !== null) {
      const request = findRequest(db, delivery.orgId, delivery.requestId);
      if (request === null || request.status !== "pending" || request.expiresAt < now) return null;
      const agent = db
        .select({ name: agents.name })
        .from(agents)
        .where(eq(agents.id, request.agentId))
        .get();
      return {
        kind: "connection",
        agent: agent?.name ?? "An agent",
        service: serviceLabel(request.details),
        reason: request.why,
        url: requestUrl(publicUrl, request.id),
        // Asking again for the same name replaces the waiting request, and its notification.
        tag: `connection:${request.agentId}:${request.details.alias}`,
      };
    }
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
        hide: proposal.hide.length,
        workdirs: proposal.workdirs.length,
        reason: proposal.reason,
        url: proposalUrl(publicUrl, proposal.id),
        // An agent's new proposal replaces its waiting one; heel's suggestions stand alone.
        tag:
          proposal.origin === "agent" ? `proposal:${proposal.agentId}` : `proposal:${proposal.id}`,
      };
    }
    if (delivery.approvalId === null) return null;
    const approval = getApproval(db, delivery.orgId, delivery.approvalId, now);
    if (approval === null || approval.status !== "pending") return null;
    const { row, agentName } = approval;
    return {
      kind: "approval",
      agent: agentName,
      action: row.call.action ?? null,
      tool: row.tool,
      method: row.call.http?.method ?? null,
      account: row.account,
      reason: row.reason,
      url: approvalUrl(publicUrl, row.id),
      // Repeats of the call join this request (I-51), so its id is the one thing decided.
      tag: `approval:${row.id}`,
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

/** What the log says about a delivery: which one, where, and about what. Never its target. */
function logFields(delivery: DeliveryRow): Record<string, string> {
  const subject =
    delivery.requestId !== null
      ? { requestId: delivery.requestId }
      : delivery.proposalId !== null
        ? { proposalId: delivery.proposalId }
        : delivery.approvalId !== null
          ? { approvalId: delivery.approvalId }
          : {};
  return { deliveryId: delivery.id, channel: delivery.channel, ...subject };
}
