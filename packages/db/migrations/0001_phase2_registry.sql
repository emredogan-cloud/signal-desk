CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`operator_relevance` real DEFAULT 0.5 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `entities_kind_idx` ON `entities` (`kind`);--> statement-breakpoint
CREATE TABLE `entity_aliases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`entity_id` text NOT NULL,
	`alias` text NOT NULL,
	`normalized` text NOT NULL,
	`requires_exact_case` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `entity_aliases_normalized_uq` ON `entity_aliases` (`normalized`);--> statement-breakpoint
CREATE INDEX `entity_aliases_entity_idx` ON `entity_aliases` (`entity_id`);--> statement-breakpoint
ALTER TABLE `sources` ADD `entity` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `is_official` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `reliability` real DEFAULT 0.5 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `poll_interval_sec` integer DEFAULT 3600 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `etag` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_modified` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_checked_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_success_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_event_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `verified_at` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `expected_value` text;--> statement-breakpoint
CREATE INDEX `sources_entity_idx` ON `sources` (`entity`);--> statement-breakpoint
CREATE INDEX `sources_last_success_idx` ON `sources` (`last_success_at`);