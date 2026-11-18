CREATE TABLE `enrollments` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `enrollments_token_hash` ON `enrollments` (`token_hash`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer NOT NULL,
	`transports` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `passkeys_user` ON `passkeys` (`user_id`);--> statement-breakpoint
CREATE TABLE `push_subscriptions` (
	`endpoint` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `push_subscriptions_user` ON `push_subscriptions` (`user_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text NOT NULL,
	`method` text NOT NULL,
	`csrf_token` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`ended_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE TABLE `webauthn_challenges` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`purpose` text NOT NULL,
	`challenge` text NOT NULL,
	`binding` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `webauthn_challenges_challenge` ON `webauthn_challenges` (`challenge`);--> statement-breakpoint
CREATE INDEX `webauthn_challenges_expires` ON `webauthn_challenges` (`expires_at`);--> statement-breakpoint
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
	CONSTRAINT "audit_log_pause_scope" CHECK("pause_scope" IS NULL OR "pause_scope" IN ('global', 'owner', 'agent', 'account', 'provider')),
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
CREATE INDEX `audit_log_approval` ON `audit_log` (`approval_id`);--> statement-breakpoint
CREATE TABLE `__new_pauses` (
	`org_id` text NOT NULL,
	`scope` text NOT NULL,
	`target` text NOT NULL,
	`paused_by` text NOT NULL,
	`paused_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `scope`, `target`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "pauses_scope" CHECK("scope" IN ('global', 'owner', 'agent', 'account', 'provider')),
	CONSTRAINT "pauses_target" CHECK(("scope" = 'global') = ("target" = ''))
);
--> statement-breakpoint
INSERT INTO `__new_pauses`("org_id", "scope", "target", "paused_by", "paused_at") SELECT "org_id", "scope", "target", "paused_by", "paused_at" FROM `pauses`;--> statement-breakpoint
DROP TABLE `pauses`;--> statement-breakpoint
ALTER TABLE `__new_pauses` RENAME TO `pauses`;