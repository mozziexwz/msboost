CREATE TABLE `config_files` (
	`relay_id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`relay_id`) REFERENCES `relays`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `fronts` (
	`relay_id` text PRIMARY KEY NOT NULL,
	`host` text NOT NULL,
	`port` integer NOT NULL,
	`job_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`relay_id`) REFERENCES `relays`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `provision_jobs` ADD `relay_id` text REFERENCES relays(id);