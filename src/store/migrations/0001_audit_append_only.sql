-- The audit log is append-only (I-73): no UPDATE or DELETE path exists in
-- the code, and these triggers refuse one from anywhere else. Retention
-- pruning, when it lands, replaces the delete trigger in its own migration.
CREATE TRIGGER `audit_log_no_update` BEFORE UPDATE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `audit_log_no_delete` BEFORE DELETE ON `audit_log`
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;
