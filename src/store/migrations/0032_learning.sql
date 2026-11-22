CREATE TABLE `learning_dismissals` (
	`user_id` text NOT NULL,
	`key` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_rule_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`rules` text NOT NULL,
	`hide` text DEFAULT '[]' NOT NULL,
	`workdirs` text DEFAULT '[]' NOT NULL,
	`reason` text,
	`origin` text DEFAULT 'agent' NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rule_proposals_status" CHECK("status" IN ('pending', 'applied', 'rejected', 'superseded', 'expired')),
	CONSTRAINT "rule_proposals_origin" CHECK("origin" IN ('agent', 'heel'))
);
--> statement-breakpoint
INSERT INTO `__new_rule_proposals`("id", "org_id", "owner_id", "agent_id", "rules", "hide", "workdirs", "reason", "origin", "status", "created_at", "expires_at", "decided_by", "decided_at") SELECT "id", "org_id", "owner_id", "agent_id", "rules", "hide", "workdirs", "reason", 'agent', "status", "created_at", "expires_at", "decided_by", "decided_at" FROM `rule_proposals`;--> statement-breakpoint
DROP TABLE `rule_proposals`;--> statement-breakpoint
ALTER TABLE `__new_rule_proposals` RENAME TO `rule_proposals`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `rule_proposals_owner_status` ON `rule_proposals` (`owner_id`,`status`);