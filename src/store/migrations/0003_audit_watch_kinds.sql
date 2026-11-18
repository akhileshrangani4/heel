PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`agent_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`run_id` text,
	`surface` text NOT NULL,
	`account` text NOT NULL,
	`provider` text NOT NULL,
	`tool` text NOT NULL,
	`action` text,
	`args` text NOT NULL,
	`call_hash` text NOT NULL,
	`rule` text,
	`approval_id` text,
	`standing_approval_id` text,
	`approver_id` text,
	`pause_scope` text,
	`reason` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "audit_log_kind" CHECK("kind" IN ('allow', 'deny', 'ask', 'paused', 'expired', 'approved', 'approval_denied', 'executed', 'would_allow', 'would_deny', 'would_ask')),
	CONSTRAINT "audit_log_pause_scope" CHECK("pause_scope" IS NULL OR "pause_scope" IN ('global', 'agent', 'account', 'provider')),
	CONSTRAINT "audit_log_args_json" CHECK(json_valid("args")),
	CONSTRAINT "audit_log_complete" CHECK(CASE "kind"
        WHEN 'allow' THEN "rule" IS NOT NULL
        WHEN 'deny' THEN "reason" IS NOT NULL
        WHEN 'ask' THEN "rule" IS NOT NULL AND "approval_id" IS NOT NULL
        WHEN 'paused' THEN "pause_scope" IS NOT NULL
        WHEN 'expired' THEN "approval_id" IS NOT NULL
        WHEN 'approved' THEN "approval_id" IS NOT NULL AND "approver_id" IS NOT NULL
        WHEN 'approval_denied' THEN "approval_id" IS NOT NULL AND "approver_id" IS NOT NULL
        WHEN 'executed' THEN "approval_id" IS NOT NULL
        WHEN 'would_allow' THEN "rule" IS NOT NULL
        WHEN 'would_deny' THEN "reason" IS NOT NULL
        WHEN 'would_ask' THEN "rule" IS NOT NULL
        ELSE 0
      END)
);
--> statement-breakpoint
INSERT INTO `__new_audit_log`("id", "org_id", "at", "kind", "agent_id", "owner_id", "run_id", "surface", "account", "provider", "tool", "action", "args", "call_hash", "rule", "approval_id", "standing_approval_id", "approver_id", "pause_scope", "reason") SELECT "id", "org_id", "at", "kind", "agent_id", "owner_id", "run_id", "surface", "account", "provider", "tool", "action", "args", "call_hash", "rule", "approval_id", "standing_approval_id", "approver_id", "pause_scope", "reason" FROM `audit_log`;--> statement-breakpoint
DROP TABLE `audit_log`;--> statement-breakpoint
ALTER TABLE `__new_audit_log` RENAME TO `audit_log`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `audit_log_org_at` ON `audit_log` (`org_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_agent_at` ON `audit_log` (`agent_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_approval` ON `audit_log` (`approval_id`);