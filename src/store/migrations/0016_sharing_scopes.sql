ALTER TABLE `standing_approvals` ADD `account` text;--> statement-breakpoint
ALTER TABLE `standing_approvals` ADD `repo` text;--> statement-breakpoint
ALTER TABLE `users` ADD `groups_synced_at` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `account_approvers_unique` ON `account_approvers` (`account_id`,`kind`,`principal`,`repo`);