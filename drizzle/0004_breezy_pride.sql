CREATE TABLE `backup_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`host` text NOT NULL,
	`port` integer DEFAULT 22 NOT NULL,
	`username` text NOT NULL,
	`remote_path` text NOT NULL,
	`credential` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_assets` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`content_type` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `content_assets_object_key_unique` ON `content_assets` (`object_key`);--> statement-breakpoint
ALTER TABLE `lines` ADD `probe_ip` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `plans` ADD `traffic_gb` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `relays` ADD `traffic_limit_bytes` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `relays` ADD `traffic_used_bytes` integer DEFAULT 0 NOT NULL;