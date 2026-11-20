CREATE TABLE `agent_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`details` text NOT NULL,
	`why` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	`account_id` text,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "agent_requests_kind" CHECK("kind" IN ('connection')),
	CONSTRAINT "agent_requests_status" CHECK("status" IN ('pending', 'approved', 'rejected', 'superseded', 'expired'))
);
--> statement-breakpoint
CREATE INDEX `agent_requests_owner_status` ON `agent_requests` (`owner_id`,`status`);--> statement-breakpoint
CREATE INDEX `agent_requests_agent_status` ON `agent_requests` (`agent_id`,`status`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`approval_id` text,
	`proposal_id` text,
	`request_id` text,
	`user_id` text NOT NULL,
	`channel` text NOT NULL,
	`target` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposal_id`) REFERENCES `rule_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`request_id`) REFERENCES `agent_requests`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notification_deliveries_subject" CHECK(("approval_id" IS NOT NULL) + ("proposal_id" IS NOT NULL) + ("request_id" IS NOT NULL) = 1),
	CONSTRAINT "notification_deliveries_channel" CHECK("channel" IN ('web_push', 'email', 'slack')),
	CONSTRAINT "notification_deliveries_status" CHECK("status" IN ('pending', 'sent', 'failed', 'dropped'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_deliveries`("id", "org_id", "approval_id", "proposal_id", "request_id", "user_id", "channel", "target", "status", "attempts", "next_attempt_at", "last_error", "created_at", "sent_at") SELECT "id", "org_id", "approval_id", "proposal_id", NULL, "user_id", "channel", "target", "status", "attempts", "next_attempt_at", "last_error", "created_at", "sent_at" FROM `notification_deliveries`;--> statement-breakpoint
DROP TABLE `notification_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_notification_deliveries` RENAME TO `notification_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_once` ON `notification_deliveries` (`approval_id`,`user_id`,`channel`,`target`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_proposal_once` ON `notification_deliveries` (`proposal_id`,`user_id`,`channel`,`target`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_request_once` ON `notification_deliveries` (`request_id`,`user_id`,`channel`,`target`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_due` ON `notification_deliveries` (`status`,`next_attempt_at`);