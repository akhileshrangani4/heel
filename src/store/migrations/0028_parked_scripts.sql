CREATE TABLE `parked_scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`approval_id` text NOT NULL,
	`run_id` text,
	`reason` text,
	`calls` text NOT NULL,
	`modules_hash` text NOT NULL,
	`snapshot` blob NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `parked_scripts_agent` ON `parked_scripts` (`agent_id`);