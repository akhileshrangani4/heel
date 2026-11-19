CREATE TABLE `rule_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`rules` text NOT NULL,
	`reason` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "rule_proposals_status" CHECK("status" IN ('pending', 'applied', 'rejected', 'superseded', 'expired'))
);
--> statement-breakpoint
CREATE INDEX `rule_proposals_owner_status` ON `rule_proposals` (`owner_id`,`status`);