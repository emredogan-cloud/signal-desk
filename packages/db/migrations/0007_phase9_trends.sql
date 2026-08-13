CREATE TABLE `trend_observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`trend_id` integer NOT NULL,
	`observed_at` integer NOT NULL,
	`mention_count` integer NOT NULL,
	`distinct_sources` integer NOT NULL,
	`manual` integer DEFAULT true NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`trend_id`) REFERENCES `trends`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `trend_obs_idx` ON `trend_observations` (`trend_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `trends` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`platform` text NOT NULL,
	`mechanism` text,
	`how_to_participate` text,
	`original_version` text,
	`stage` text DEFAULT 'UNKNOWN' NOT NULL,
	`saturation` real DEFAULT 0 NOT NULL,
	`stage_explanation` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trends_name_unique` ON `trends` (`name`);--> statement-breakpoint
CREATE INDEX `trends_stage_idx` ON `trends` (`stage`);