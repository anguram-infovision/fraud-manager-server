ALTER TABLE `alerts` ADD `recurrence_count` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `alerts` ADD `last_seen_at` text;--> statement-breakpoint
ALTER TABLE `system_settings` ADD `cooldown_minutes` integer DEFAULT 60 NOT NULL;