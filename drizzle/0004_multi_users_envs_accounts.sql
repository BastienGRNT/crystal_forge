CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`owner` text,
	`config` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_kind_label_idx` ON `accounts` (`kind`,`label`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`ts` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`user_id` integer,
	`username` text NOT NULL,
	`method` text NOT NULL,
	`path` text NOT NULL,
	`status` integer NOT NULL,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_ts_idx` ON `audit_log` (`ts`);--> statement-breakpoint
CREATE TABLE `password_resets` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `project_members` (
	`user_id` integer NOT NULL,
	`project_id` integer NOT NULL,
	`level` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	PRIMARY KEY(`user_id`, `project_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text DEFAULT 'collaborator' NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_idx` ON `users` (`username`);--> statement-breakpoint
ALTER TABLE `projects` ADD `environment` text DEFAULT 'production' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `user_id` integer;--> statement-breakpoint
-- Le compte admin unique devient l'utilisateur « admin » (même mot de passe). Les sessions
-- ouvertes sont fermées : elles ne sont pas rattachées à un utilisateur.
INSERT INTO `users` (`username`, `password_hash`, `role`) SELECT 'admin', `password_hash`, 'admin' FROM `admin` WHERE `id` = 1;--> statement-breakpoint
DELETE FROM `sessions`;
