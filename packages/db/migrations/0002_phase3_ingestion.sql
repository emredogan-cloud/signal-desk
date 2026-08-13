CREATE TABLE `fetch_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`duration_ms` integer NOT NULL,
	`outcome` text NOT NULL,
	`http_status` integer,
	`items_found` integer DEFAULT 0 NOT NULL,
	`items_new` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`not_modified` integer DEFAULT false NOT NULL,
	`error` text,
	`trace_id` text NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `fetch_log_source_started_idx` ON `fetch_log` (`source_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `fetch_log_started_idx` ON `fetch_log` (`started_at`);--> statement-breakpoint
CREATE TABLE `raw_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`author` text,
	`published_at` integer,
	`fetched_at` integer NOT NULL,
	`content_hash` text NOT NULL,
	`raw_payload` text NOT NULL,
	`trace_id` text NOT NULL,
	`http_status` integer,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE UNIQUE INDEX `raw_items_source_external_uq` ON `raw_items` (`source_id`,`external_id`);--> statement-breakpoint
CREATE INDEX `raw_items_content_hash_idx` ON `raw_items` (`content_hash`);--> statement-breakpoint
CREATE INDEX `raw_items_fetched_at_idx` ON `raw_items` (`fetched_at`);--> statement-breakpoint
CREATE INDEX `raw_items_published_at_idx` ON `raw_items` (`published_at`);--> statement-breakpoint
CREATE INDEX `raw_items_source_idx` ON `raw_items` (`source_id`);--> statement-breakpoint
ALTER TABLE `sources` ADD `consecutive_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `circuit_open_until` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `last_error_message` text;