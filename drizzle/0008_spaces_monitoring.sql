CREATE TABLE `notifications` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer NOT NULL,
	`kind` text NOT NULL,
	`level` text NOT NULL,
	`project_id` integer,
	`title` text NOT NULL,
	`body` text,
	`href` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_ts_idx` ON `notifications` (`ts`);--> statement-breakpoint
CREATE TABLE `space_members` (
	`user_id` integer NOT NULL,
	`space_id` integer NOT NULL,
	`level` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `space_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`space_id`) REFERENCES `spaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `spaces` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'blue' NOT NULL,
	`icon` text DEFAULT 'folder' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `uptime_checks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`domain_id` integer NOT NULL,
	`ts` integer NOT NULL,
	`ok` integer NOT NULL,
	`status` integer,
	`ms` integer,
	`error` text,
	FOREIGN KEY (`domain_id`) REFERENCES `domains`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `uptime_checks_domain_ts_idx` ON `uptime_checks` (`domain_id`,`ts`);--> statement-breakpoint
CREATE INDEX `uptime_checks_ts_idx` ON `uptime_checks` (`ts`);--> statement-breakpoint
ALTER TABLE `projects` ADD `space_id` integer REFERENCES spaces(id);--> statement-breakpoint
ALTER TABLE `projects` ADD `tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `notifications_seen_at` integer DEFAULT 0 NOT NULL;