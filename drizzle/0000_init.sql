CREATE TABLE `identity_mappings` (
	`id` text PRIMARY KEY NOT NULL,
	`from_player_id` text NOT NULL,
	`to_player_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `match_events` (
	`id` text PRIMARY KEY NOT NULL,
	`match_id` text NOT NULL,
	`server_seq` integer NOT NULL,
	`sequence` integer NOT NULL,
	`type` text NOT NULL,
	`timestamp` text NOT NULL,
	`source` text NOT NULL,
	`point_group_id` text,
	`corrects_event_id` text,
	`payload` text NOT NULL,
	`received_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `match_events_seq_idx` ON `match_events` (`match_id`,`server_seq`);--> statement-breakpoint
CREATE INDEX `match_events_match_idx` ON `match_events` (`match_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `match_events_group_idx` ON `match_events` (`match_id`,`point_group_id`);--> statement-breakpoint
CREATE TABLE `matches` (
	`id` text PRIMARY KEY NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`config` text NOT NULL,
	`my_player_id` text,
	`opponent_id` text,
	`tournament_key` text,
	`authorized` integer DEFAULT 1 NOT NULL,
	`synced_at` text DEFAULT (current_timestamp) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `matches_updated_at_idx` ON `matches` (`updated_at`);--> statement-breakpoint
CREATE INDEX `matches_tournament_idx` ON `matches` (`tournament_key`);--> statement-breakpoint
CREATE TABLE `players` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`role` text NOT NULL,
	`aliases` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`previous_version_id` text,
	`handedness` text,
	`usta_id` text,
	`usta_url` text,
	`notes` text
);
--> statement-breakpoint
CREATE TABLE `share_links` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`match_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	`include_mental_states` integer DEFAULT 0 NOT NULL,
	`opponent_display` text DEFAULT 'initials' NOT NULL,
	`include_timeline` integer DEFAULT 1 NOT NULL,
	`label` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_links_token_idx` ON `share_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `share_links_match_idx` ON `share_links` (`match_id`);