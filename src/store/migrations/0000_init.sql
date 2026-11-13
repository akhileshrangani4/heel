CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`alias` text NOT NULL,
	`provider` text NOT NULL,
	`settings` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_org_alias` ON `accounts` (`org_id`,`alias`);--> statement-breakpoint
CREATE TABLE `agent_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tokens_hash` ON `agent_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `agent_tokens_agent` ON `agent_tokens` (`agent_id`);--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_org_name` ON `agents` (`org_id`,`name`);--> statement-breakpoint
CREATE TABLE `approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`run_id` text,
	`call_hash` text NOT NULL,
	`account` text NOT NULL,
	`tool` text NOT NULL,
	`call` text NOT NULL,
	`origin` text NOT NULL,
	`rule` text NOT NULL,
	`rule_hash` text NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	`executed_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `approvals_call_hash` ON `approvals` (`call_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `approvals_one_pending_per_call` ON `approvals` (`call_hash`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `approvals_status_expires` ON `approvals` (`status`,`expires_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
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
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `audit_log_org_at` ON `audit_log` (`org_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_agent_at` ON `audit_log` (`agent_id`,`at`);--> statement-breakpoint
CREATE INDEX `audit_log_approval` ON `audit_log` (`approval_id`);--> statement-breakpoint
CREATE TABLE `count_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`run_id` text,
	`fields` text NOT NULL,
	`items` integer NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `count_events_agent_at` ON `count_events` (`agent_id`,`at`);--> statement-breakpoint
CREATE INDEX `count_events_agent_run` ON `count_events` (`agent_id`,`run_id`);--> statement-breakpoint
CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`account_id` text NOT NULL,
	`key_version` integer NOT NULL,
	`wrapped_key` blob NOT NULL,
	`ciphertext` blob NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_account` ON `credentials` (`account_id`);--> statement-breakpoint
CREATE TABLE `orgs` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pauses` (
	`org_id` text NOT NULL,
	`scope` text NOT NULL,
	`target` text NOT NULL,
	`paused_by` text NOT NULL,
	`paused_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `scope`, `target`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `standing_approvals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`scope` text NOT NULL,
	`call_hash` text,
	`rule` text NOT NULL,
	`rule_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revoked_by` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `standing_approvals_agent_rule` ON `standing_approvals` (`agent_id`,`rule_hash`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`oidc_subject` text,
	`role` text NOT NULL,
	`created_at` integer NOT NULL,
	`disabled_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_org_name` ON `users` (`org_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_oidc_subject` ON `users` (`oidc_subject`);--> statement-breakpoint
CREATE TABLE `vault_keys` (
	`version` integer PRIMARY KEY NOT NULL,
	`check` blob NOT NULL,
	`created_at` integer NOT NULL
);
