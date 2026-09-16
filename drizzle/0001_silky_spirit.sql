CREATE TABLE `suppression_log` (
	`id` text PRIMARY KEY NOT NULL,
	`loan_id` text NOT NULL,
	`engine` text NOT NULL,
	`scenario` text NOT NULL,
	`reason` text NOT NULL,
	`value` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `system_settings` (
	`id` text PRIMARY KEY DEFAULT 'default' NOT NULL,
	`aml_alert_threshold` real DEFAULT 60 NOT NULL,
	`mature_loan_payment_count` integer DEFAULT 6 NOT NULL,
	`established_loan_payment_count` integer DEFAULT 3 NOT NULL,
	`normal_payment_range_multiplier` real DEFAULT 1.5 NOT NULL,
	`suppressions_enabled` integer DEFAULT true NOT NULL,
	`updated_at` text NOT NULL
);
