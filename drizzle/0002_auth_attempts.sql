CREATE TABLE `auth_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`ip` text NOT NULL,
	`attempted_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `auth_attempts_ip_idx` ON `auth_attempts` (`ip`,`attempted_at`);