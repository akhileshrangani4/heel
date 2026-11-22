ALTER TABLE `approvals` ADD `script` text;--> statement-breakpoint
ALTER TABLE `parked_scripts` ADD `code` text DEFAULT '' NOT NULL;