-- 0003 rebuilt audit_log to widen its CHECK constraints, and dropping the
-- old table dropped its append-only triggers with it (I-73). Both migrations
-- run in one transaction, so no write ever sees the table without them.
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
