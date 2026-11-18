CREATE TABLE `approval_hints` (
	`approval_id` text NOT NULL,
	`adapter` text NOT NULL,
	`status` text NOT NULL,
	`hints` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`approval_id`, `adapter`),
	FOREIGN KEY (`approval_id`) REFERENCES `approvals`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "approval_hints_status" CHECK("status" IN ('ok', 'unavailable'))
);
