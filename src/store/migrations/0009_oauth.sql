CREATE TABLE `oauth_clients` (
	`id` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`name` text NOT NULL,
	`redirect_uris` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `oauth_codes` (
	`code_hash` text PRIMARY KEY NOT NULL,
	`org_id` text NOT NULL,
	`client_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`redirect_uri` text NOT NULL,
	`code_challenge` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	FOREIGN KEY (`org_id`) REFERENCES `orgs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_clients`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `kind` text DEFAULT 'static' NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_tokens` ADD `expires_at` integer;--> statement-breakpoint
ALTER TABLE `agents` ADD `oauth_client_id` text;