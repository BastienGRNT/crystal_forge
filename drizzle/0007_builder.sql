ALTER TABLE `projects` ADD `build_mode` text DEFAULT 'runner' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `deploy_dir` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `deployed_sha` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_deploy` integer DEFAULT true NOT NULL;