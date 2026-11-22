CREATE TABLE `background_scripts` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`token_id` text NOT NULL,
	`status` text NOT NULL,
	`approval_id` text,
	`parked_id` text,
	`calls` integer DEFAULT 0 NOT NULL,
	`result` blob,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "background_scripts_status" CHECK("status" IN ('running', 'parked', 'completed', 'error', 'paused', 'stopped', 'ended'))
);
--> statement-breakpoint
CREATE INDEX `background_scripts_owner` ON `background_scripts` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `background_scripts_one_active` ON `background_scripts` (`agent_id`) WHERE "status" IN ('running', 'parked');