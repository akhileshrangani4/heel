CREATE TABLE `siem_cursors` (
	`org_id` text NOT NULL,
	`sink` text NOT NULL,
	`delivered_through_id` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `sink`),
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
