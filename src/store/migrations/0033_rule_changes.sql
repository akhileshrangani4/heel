CREATE TABLE `rule_changes` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`user_id` text,
	`file` text NOT NULL,
	`at` integer NOT NULL,
	`source` text NOT NULL,
	`proposal_id` text,
	`decided_by` text,
	`diff` text NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposal_id`) REFERENCES `rule_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rule_changes_source" CHECK("source" IN ('proposal', 'outside'))
);
--> statement-breakpoint
CREATE INDEX `rule_changes_user_at` ON `rule_changes` (`user_id`,`at`);--> statement-breakpoint
CREATE TABLE `rule_file_snapshots` (
	`file` text PRIMARY KEY NOT NULL,
	`text` text NOT NULL,
	`seen_at` integer NOT NULL
);
