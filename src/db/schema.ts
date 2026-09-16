import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core';

export const alerts = sqliteTable('alerts', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  severity: text('severity').notNull(),
  status: text('status').notNull().default('OPEN'),
  borrowerId: text('borrower_id').notNull(),
  loanId: text('loan_id').notNull(),
  transactionIds: text('transaction_ids').notNull(),
  riskScore: real('risk_score').notNull(),
  signals: text('signals').notNull(),
  braintreeSignals: text('braintree_signals').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const alertNotes = sqliteTable('alert_notes', {
  id: text('id').primaryKey(),
  alertId: text('alert_id')
    .notNull()
    .references(() => alerts.id),
  text: text('text').notNull(),
  createdAt: text('created_at').notNull(),
});

export const scenarioConfigs = sqliteTable('scenario_configs', {
  scenario: text('scenario').primaryKey(),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  parameters: text('parameters').notNull(),
  severity: text('severity').notNull().default('MEDIUM'),
  updatedAt: text('updated_at').notNull(),
});

export const auditLog = sqliteTable('audit_log', {
  id: text('id').primaryKey(),
  alertId: text('alert_id').notNull(),
  action: text('action').notNull(),
  previousValue: text('previous_value'),
  newValue: text('new_value'),
  createdAt: text('created_at').notNull(),
});

// Singleton row (id='default') — global correlation/suppression settings.
export const systemSettings = sqliteTable('system_settings', {
  id: text('id').primaryKey().default('default'),
  amlAlertThreshold: real('aml_alert_threshold').notNull().default(60),
  matureLoanPaymentCount: integer('mature_loan_payment_count').notNull().default(6),
  establishedLoanPaymentCount: integer('established_loan_payment_count').notNull().default(3),
  normalPaymentRangeMultiplier: real('normal_payment_range_multiplier').notNull().default(1.5),
  suppressionsEnabled: integer('suppressions_enabled', { mode: 'boolean' }).notNull().default(true),
  updatedAt: text('updated_at').notNull(),
});

// Signals that were detected but suppressed (not turned into an alert) — audit trail
// for false-positive-reduction tuning. See PROJECT.md "Suppression" section.
export const suppressionLog = sqliteTable('suppression_log', {
  id: text('id').primaryKey(),
  loanId: text('loan_id').notNull(),
  engine: text('engine').notNull(), // 'FRAUD' | 'AML'
  scenario: text('scenario').notNull(),
  reason: text('reason').notNull(),
  value: text('value'),
  createdAt: text('created_at').notNull(),
});
