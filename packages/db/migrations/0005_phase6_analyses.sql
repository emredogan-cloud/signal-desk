CREATE TABLE `analyses` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`payload` text,
	`confidence` text,
	`recommended_action` text,
	`injection_observed` integer DEFAULT false NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cache_read_tokens` integer DEFAULT 0 NOT NULL,
	`cache_write_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micro_usd` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `analyses_event_idx` ON `analyses` (`event_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `analyses_stage_idx` ON `analyses` (`stage`,`created_at`);--> statement-breakpoint
CREATE INDEX `analyses_cost_idx` ON `analyses` (`created_at`);