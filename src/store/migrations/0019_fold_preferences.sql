CREATE TABLE `fold_preferences` (
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`section` text NOT NULL,
	`open` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `kind`, `section`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
