import type { SiemConfig } from "../config/schema.ts";
import type { Logger } from "../log.ts";
import type { AdminAlert, AdminAlerts } from "../notify/admin-alerts.ts";
import { advanceSiemCursor, auditBacklog, readAuditPage, readSiemCursor } from "../store/audit.ts";
import type { HeelDb } from "../store/db.ts";
import { loadSecret } from "../vault/secret-file.ts";
import { auditJsonLine } from "./jsonl.ts";

/**
 * The optional SIEM sink (spec: Teams, "Audit"): batched HTTPS POSTs of JSON
 * Lines, retried with backoff. It only ever reads the audit log, on its own
 * timer, so an outage changes no decision and drops no row: the durable
 * cursor advances only after the sink acknowledges a batch. Delivery is
 * at-least-once; a crash between the sink's 2xx and the cursor write
 * re-sends that batch, and each line's `id` lets the SIEM drop the repeat.
 */

export const SIEM_TOKEN_ENV = "HEEL_SIEM_TOKEN";

/** The longest wait between retries, however long the outage lasts. */
export const SIEM_MAX_BACKOFF_MS = 5 * 60_000;

/** Admin alerts the sink raises (spec: Fail-closed behavior, "The SIEM sink is down"). */
export type SiemAlert = Extract<AdminAlert, { kind: "siem_backlog" | "siem_backlog_cleared" }>;

export type DeliveryOutcome =
  | { kind: "idle" }
  | { kind: "delivered"; rows: number; throughId: number; more: boolean }
  | { kind: "failed"; error: string };

/** Pure: the wait before retry number `failures` (1-based): doubling from the interval, capped. */
export function siemBackoffMs(failures: number, intervalMs: number): number {
  const exponent = Math.min(Math.max(failures - 1, 0), 20);
  return Math.min(intervalMs * 2 ** exponent, Math.max(SIEM_MAX_BACKOFF_MS, intervalMs));
}

/** Pure: whether undelivered rows exceed the configured alert thresholds. */
export function isSiemBacklogged(
  backlog: { rows: number; oldestAt: Date | null },
  threshold: SiemConfig["backlogAlert"],
  now: Date,
): boolean {
  if (backlog.rows === 0 || backlog.oldestAt === null) return false;
  return (
    backlog.rows >= threshold.rows || now.getTime() - backlog.oldestAt.getTime() >= threshold.ageMs
  );
}

/** Pure: a short, value-free description of a failed delivery. */
export function describeDeliveryError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError") return "timeout";
    if (error.name === "AbortError") return "aborted";
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.name}${cause}`;
  }
  return "unknown error";
}

export interface SiemSinkOptions {
  db: HeelDb;
  orgId: string;
  config: SiemConfig;
  env: Readonly<Record<string, string | undefined>>;
  log: Logger;
  alerts: AdminAlerts;
  fetch?: typeof fetch;
  now?: () => Date;
}

export class SiemSink {
  readonly #options: SiemSinkOptions;
  readonly #sink: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #closing = new AbortController();
  #timer: NodeJS.Timeout | null = null;
  #inFlight: Promise<void> | null = null;
  #failures = 0;
  #lastError: string | null = null;
  #alerting = false;

  constructor(options: SiemSinkOptions) {
    this.#options = options;
    this.#sink = options.config.url.href;
    this.#fetch = options.fetch ?? fetch;
    this.#now = options.now ?? (() => new Date());
  }

  /** Starts the delivery loop; the first attempt runs at once. */
  start(): void {
    this.#schedule(0);
  }

  /** Stops the loop, aborting a request in flight. Undelivered rows wait for the next start. */
  async close(): Promise<void> {
    this.#closing.abort();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    await this.#inFlight;
  }

  /**
   * One delivery attempt: the next batch after the cursor, then a backlog
   * check. Never throws for a sink-side failure; a store error propagates.
   */
  async deliverOnce(): Promise<DeliveryOutcome> {
    const outcome = await this.#attempt();
    if (outcome.kind === "failed") {
      this.#failures += 1;
      this.#lastError = outcome.error;
    } else {
      this.#failures = 0;
      this.#lastError = null;
    }
    this.#checkBacklog();
    return outcome;
  }

  async #attempt(): Promise<DeliveryOutcome> {
    const { db, orgId, config } = this.#options;
    const cursor = readSiemCursor(db, orgId, this.#sink);
    const rows = readAuditPage(db, {
      orgId,
      afterId: cursor,
      throughId: Number.MAX_SAFE_INTEGER,
      limit: config.batchSize,
    });
    const last = rows.at(-1);
    if (!last) return { kind: "idle" };

    const headers: Record<string, string> = { "content-type": "application/x-ndjson" };
    if (config.auth) {
      let token: string;
      try {
        token = loadSecret(this.#options.env, SIEM_TOKEN_ENV, config.auth.tokenFile).reveal();
      } catch (error) {
        return { kind: "failed", error: `token unavailable: ${(error as Error).message}` };
      }
      headers[config.auth.header.toLowerCase()] =
        config.auth.scheme === "" ? token : `${config.auth.scheme} ${token}`;
    }

    let response: Response;
    try {
      response = await this.#fetch(config.url, {
        method: "POST",
        headers,
        body: rows.map(auditJsonLine).join(""),
        // A redirect could carry the token to another host; treat it as a failure.
        redirect: "error",
        signal: AbortSignal.any([AbortSignal.timeout(config.timeoutMs), this.#closing.signal]),
      });
    } catch (error) {
      return { kind: "failed", error: describeDeliveryError(error) };
    }
    // Drain the body so the connection can be reused; its content is not needed.
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) return { kind: "failed", error: `HTTP ${response.status}` };

    advanceSiemCursor(db, orgId, this.#sink, last.id, this.#now());
    return {
      kind: "delivered",
      rows: rows.length,
      throughId: last.id,
      more: rows.length === config.batchSize,
    };
  }

  #checkBacklog(): void {
    const { db, orgId, config, alerts } = this.#options;
    const now = this.#now();
    const backlog = auditBacklog(db, orgId, readSiemCursor(db, orgId, this.#sink));
    const backlogged = isSiemBacklogged(backlog, config.backlogAlert, now);
    if (backlogged && !this.#alerting) {
      this.#alerting = true;
      alerts.raise({
        kind: "siem_backlog",
        sink: this.#sink,
        pendingRows: backlog.rows,
        oldestPendingAgeMs: backlog.oldestAt ? now.getTime() - backlog.oldestAt.getTime() : 0,
        lastError: this.#lastError,
      });
    } else if (!backlogged && this.#alerting) {
      this.#alerting = false;
      alerts.raise({ kind: "siem_backlog_cleared", sink: this.#sink });
    }
  }

  #schedule(delayMs: number): void {
    if (this.#closing.signal.aborted) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#inFlight = this.#tick().finally(() => {
        this.#inFlight = null;
      });
    }, delayMs);
    this.#timer.unref();
  }

  async #tick(): Promise<void> {
    const { config, log } = this.#options;
    let next = config.intervalMs;
    try {
      const outcome = await this.deliverOnce();
      if (outcome.kind === "delivered" && outcome.more) next = 0;
      if (outcome.kind === "failed") {
        next = siemBackoffMs(this.#failures, config.intervalMs);
        log.warn(
          { sink: this.#sink, error: outcome.error, failures: this.#failures, retryInMs: next },
          "SIEM delivery failed",
        );
      }
    } catch (error) {
      this.#failures += 1;
      next = siemBackoffMs(this.#failures, config.intervalMs);
      log.error({ err: error, sink: this.#sink, retryInMs: next }, "SIEM sink error");
    }
    this.#schedule(next);
  }
}
