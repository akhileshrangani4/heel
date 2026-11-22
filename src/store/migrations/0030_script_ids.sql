ALTER TABLE `audit_log` ADD `script_id` text;--> statement-breakpoint
CREATE INDEX `audit_log_script` ON `audit_log` (`script_id`);--> statement-breakpoint
ALTER TABLE `parked_scripts` ADD `script_id` text;