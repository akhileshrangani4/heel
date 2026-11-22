PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rule_changes` (
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
	CONSTRAINT "rule_changes_source" CHECK("source" IN ('proposal', 'outside', 'web'))
);
--> statement-breakpoint
INSERT INTO `__new_rule_changes`("id", "org_id", "user_id", "file", "at", "source", "proposal_id", "decided_by", "diff") SELECT "id", "org_id", "user_id", "file", "at", "source", "proposal_id", "decided_by", "diff" FROM `rule_changes`;--> statement-breakpoint
DROP TABLE `rule_changes`;--> statement-breakpoint
ALTER TABLE `__new_rule_changes` RENAME TO `rule_changes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `rule_changes_user_at` ON `rule_changes` (`user_id`,`at`);