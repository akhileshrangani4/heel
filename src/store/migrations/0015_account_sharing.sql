CREATE TABLE `account_approvers` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`principal` text NOT NULL,
	`repo` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `account_approvers_account` ON `account_approvers` (`account_id`);--> statement-breakpoint
CREATE TABLE `account_shares` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`account_id` text NOT NULL,
	`kind` text NOT NULL,
	`principal` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_shares_unique` ON `account_shares` (`account_id`,`kind`,`principal`);