CREATE TABLE `alert_notes` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`severity` text NOT NULL,
	`status` text DEFAULT 'OPEN' NOT NULL,
	`borrower_id` text NOT NULL,
	`loan_id` text NOT NULL,
	`transaction_ids` text NOT NULL,
	`risk_score` real NOT NULL,
	`signals` text NOT NULL,
	`braintree_signals` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`action` text NOT NULL,
	`previous_value` text,
	`new_value` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `scenario_configs` (
	`scenario` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`parameters` text NOT NULL,
	`severity` text DEFAULT 'MEDIUM' NOT NULL,
	`updated_at` text NOT NULL
);
