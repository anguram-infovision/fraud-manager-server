CREATE TABLE `monitor_records` (
	`id` text PRIMARY KEY NOT NULL,
	`loan_id` text NOT NULL,
	`borrower_id` text NOT NULL,
	`engine` text NOT NULL,
	`tier` text DEFAULT 'MONITOR' NOT NULL,
	`scenario_key` text NOT NULL,
	`transaction_ids` text NOT NULL,
	`risk_score` real NOT NULL,
	`signals` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
