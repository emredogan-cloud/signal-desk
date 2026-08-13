CREATE TABLE `event_scores` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`importance` integer NOT NULL,
	`brand_relevance` integer NOT NULL,
	`velocity` integer NOT NULL,
	`combined` integer NOT NULL,
	`confidence` text NOT NULL,
	`evidence_tag` text NOT NULL,
	`breakdown` text NOT NULL,
	`caps` text NOT NULL,
	`gate_passed` integer NOT NULL,
	`gate_killed_by` text,
	`gate_reason` text NOT NULL,
	`scored_with` text NOT NULL,
	`scored_at` integer NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_scores_event_idx` ON `event_scores` (`event_id`,`scored_at`);--> statement-breakpoint
CREATE INDEX `event_scores_combined_idx` ON `event_scores` (`combined`);--> statement-breakpoint
CREATE INDEX `event_scores_gate_idx` ON `event_scores` (`gate_passed`);