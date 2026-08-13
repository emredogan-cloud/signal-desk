CREATE TABLE `event_embeddings` (
	`event_id` integer PRIMARY KEY NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`embedding` blob NOT NULL,
	`source_text` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`category` text NOT NULL,
	`entities` text NOT NULL,
	`artifacts` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`event_occurred_at` integer NOT NULL,
	`occurred_at_is_estimated` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	`primary_source_id` text NOT NULL,
	`primary_raw_item_id` integer NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`evidence_count` integer DEFAULT 0 NOT NULL,
	`distinct_source_count` integer DEFAULT 1 NOT NULL,
	`has_official_source` integer DEFAULT false NOT NULL,
	`injection_flagged` integer DEFAULT false NOT NULL,
	`merged_into_event_id` integer,
	FOREIGN KEY (`primary_source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`primary_raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `events_occurred_idx` ON `events` (`event_occurred_at`);--> statement-breakpoint
CREATE INDEX `events_first_seen_idx` ON `events` (`first_seen_at`);--> statement-breakpoint
CREATE INDEX `events_category_idx` ON `events` (`category`);--> statement-breakpoint
CREATE INDEX `events_status_idx` ON `events` (`status`);--> statement-breakpoint
CREATE INDEX `events_merged_idx` ON `events` (`merged_into_event_id`);--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`raw_item_id` integer NOT NULL,
	`source_id` text NOT NULL,
	`role` text NOT NULL,
	`merge_stage` integer,
	`similarity` real,
	`canonical_url` text NOT NULL,
	`content_hash` text NOT NULL,
	`attached_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`raw_item_id`) REFERENCES `raw_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `evidence_raw_item_uq` ON `evidence` (`raw_item_id`);--> statement-breakpoint
CREATE INDEX `evidence_event_idx` ON `evidence` (`event_id`);--> statement-breakpoint
CREATE INDEX `evidence_source_idx` ON `evidence` (`source_id`);--> statement-breakpoint
CREATE TABLE `merge_audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`action` text NOT NULL,
	`raw_item_id` integer NOT NULL,
	`from_event_id` integer,
	`to_event_id` integer,
	`stage` integer,
	`similarity` real,
	`reason` text NOT NULL,
	`actor` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `merge_audit_raw_item_idx` ON `merge_audit` (`raw_item_id`);--> statement-breakpoint
CREATE INDEX `merge_audit_event_idx` ON `merge_audit` (`to_event_id`);