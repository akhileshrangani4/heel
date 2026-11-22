CREATE TABLE `learning_dismissals` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `rule_proposals` ADD `origin` text DEFAULT 'agent' NOT NULL CONSTRAINT "rule_proposals_origin" CHECK("origin" IN ('agent', 'heel'));
