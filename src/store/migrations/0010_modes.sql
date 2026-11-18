CREATE TABLE `mode_changes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`from_mode` text NOT NULL,
	`to_mode` text NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mode_changes_org_at` ON `mode_changes` (`org_id`,`changed_at`);--> statement-breakpoint
CREATE TABLE `modes` (
	`org_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`mode` text NOT NULL,
	`set_by` text NOT NULL,
	`set_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `owner_id`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "modes_mode" CHECK("mode" IN ('enforce', 'shadow', 'record'))
);
--> statement-breakpoint
ALTER TABLE `audit_log` ADD `mode` text;