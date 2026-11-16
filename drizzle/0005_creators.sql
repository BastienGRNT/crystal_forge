ALTER TABLE `projects` ADD `owner_id` integer REFERENCES users(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `users` ADD `can_create_projects` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `max_projects` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `max_ram_mb` integer DEFAULT 2048 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `allowed_zones` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `github_login` text;--> statement-breakpoint
ALTER TABLE `users` ADD `requires_approval` integer DEFAULT true NOT NULL;