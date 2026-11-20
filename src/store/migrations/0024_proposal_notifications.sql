PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`approval_id` text,
	`proposal_id` text,
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
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notification_deliveries_subject" CHECK(("approval_id" IS NULL) <> ("proposal_id" IS NULL)),
	CONSTRAINT "notification_deliveries_channel" CHECK("channel" IN ('web_push', 'email', 'slack')),
	CONSTRAINT "notification_deliveries_status" CHECK("status" IN ('pending', 'sent', 'failed', 'dropped'))
);
--> statement-breakpoint
INSERT INTO `__new_notification_deliveries`("id", "org_id", "approval_id", "proposal_id", "user_id", "channel", "target", "status", "attempts", "next_attempt_at", "last_error", "created_at", "sent_at") SELECT "id", "org_id", "approval_id", NULL, "user_id", "channel", "target", "status", "attempts", "next_attempt_at", "last_error", "created_at", "sent_at" FROM `notification_deliveries`;--> statement-breakpoint
DROP TABLE `notification_deliveries`;--> statement-breakpoint
ALTER TABLE `__new_notification_deliveries` RENAME TO `notification_deliveries`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_once` ON `notification_deliveries` (`approval_id`,`user_id`,`channel`,`target`);--> statement-breakpoint
CREATE UNIQUE INDEX `notification_deliveries_proposal_once` ON `notification_deliveries` (`proposal_id`,`user_id`,`channel`,`target`);--> statement-breakpoint
CREATE INDEX `notification_deliveries_due` ON `notification_deliveries` (`status`,`next_attempt_at`);