import type { Logger } from "../log.ts";

/**
 * Alerts for the install's admins (spec: Fail-closed behavior). Until the
 * notification channels land (D4b), `heel serve` writes them to the log.
 */
export type AdminAlert =
  /** The SIEM sink is behind the audit log ("The SIEM sink is down"). */
  | {
      kind: "siem_backlog";
      sink: string;
      pendingRows: number;
      oldestPendingAgeMs: number;
      /** Why the last delivery failed; null when the sink is up but slower than the log. */
      lastError: string | null;
    }
  | { kind: "siem_backlog_cleared"; sink: string }
  /**
   * SQLite refused a read or write a decision needed, so the call was denied
   * ("SQLite read or write fails, or the disk is full"). `code` is SQLite's
   * result code, e.g. `SQLITE_READONLY` or `SQLITE_FULL`; never a message,
   * which can carry the statement's parameters.
   */
  | { kind: "store_unavailable"; code: string };

export interface AdminAlerts {
  raise(alert: AdminAlert): void;
}

/** Admin alerts as log lines: the channel until D4b's notifications exist. */
export function logAdminAlerts(log: Logger): AdminAlerts {
  return {
    raise: (alert) => {
      switch (alert.kind) {
        case "siem_backlog":
          log.error({ alert }, "admin alert: SIEM sink is behind");
          return;
        case "siem_backlog_cleared":
          log.info({ alert }, "admin alert cleared: SIEM sink caught up");
          return;
        case "store_unavailable":
          log.error({ alert }, "admin alert: the database refused a decision; calls are denied");
          return;
      }
    },
  };
}
