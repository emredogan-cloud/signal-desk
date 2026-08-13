CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`platform` text NOT NULL,
	`category` text NOT NULL,
	`priority` integer NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sources_active_priority_idx` ON `sources` (`active`,`priority`);--> statement-breakpoint
CREATE INDEX `sources_platform_idx` ON `sources` (`platform`);