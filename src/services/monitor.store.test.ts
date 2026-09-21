import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentHistory } from './appsolute.service.js';
import type { BraintreeTransaction } from './braintree.service.js';

const dbPath = join(tmpdir(), `fraud-monitor-test-${process.pid}.db`);
process.env['DB_PATH'] = dbPath;
const { db } = await import('../db/index.js');
const { alerts, monitorRecords } = await import('../db/schema.js');
const { migrate } = await import('drizzle-orm/libsql/migrator');
const { evaluateAml } = await import('./aml-engine.service.js');
const { recordMonitor } = await import('./monitor.store.js');
const { listAlerts } = await import('./alerts.store.js');

await migrate(db, { migrationsFolder: './drizzle' });

const borrower = { borrowerId: 'B1', loanId: 'L1', expectedMonthlyPayment: 2500, loanStatus: 'ACTIVE' };
const tx = {
  id: 'tx', legacyId: 'PN-current', amount: { value: '8000.00', currencyCode: 'USD' }, // > 2× EMI
  status: 'SETTLED', createdAt: new Date().toISOString(),
} as BraintreeTransaction;

const day = 86_400_000;
const pay = (i: number, fundingSource: string): PaymentHistory => ({
  transactionId: `t${i}`, amount: 2500, paymentMethod: `PNREF-${i}`, fundingSource,
  createdAt: new Date(Date.now() - i * day).toISOString(), status: 'SETTLED', isRefund: false, isDispute: false,
});
// 3 new sources in the window (MULTIPLE_PAYMENT_SOURCES) + an $8000 payment (AMOUNT_DEVIATION) = 2 scenarios = 50
const history = [pay(1, '411111-1111'), pay(2, '510510-5100'), pay(3, '378282-0005')];

test('exactly 2 fired scenarios (score 50) → monitor, not an alert', () => {
  const r = evaluateAml(tx, borrower, history);
  assert.deepEqual(r.signals.map((s) => s.scenario).sort(), ['AMOUNT_DEVIATION', 'MULTIPLE_PAYMENT_SOURCES']);
  assert.equal(r.riskScore, 50);
  assert.equal(r.triggered, false);
  assert.equal(r.monitor, true);
});

test('3 fired scenarios reach the alert threshold and are not monitor-tier', () => {
  const r = evaluateAml(tx, borrower, [...history, { ...pay(4, '411111-1111'), isRefund: true }, { ...pay(5, '411111-1111'), isDispute: true }]);
  assert.equal(r.triggered, true);
  assert.equal(r.monitor, false);
});

test('a clean evaluation (score 0) is not recorded', () => {
  const r = evaluateAml({ ...tx, amount: { value: '2500.00', currencyCode: 'USD' } }, borrower, [pay(1, '411111-1111')]);
  assert.equal(r.monitor, false);
});

test('monitor record is persisted, queryable, deduped, and absent from the alert queue', async () => {
  const r = evaluateAml(tx, borrower, history);
  const input = { loanId: 'L1', borrowerId: 'B1', transactionIds: ['PN-1'], riskScore: r.riskScore, signals: r.signals };
  await recordMonitor(input);
  await recordMonitor({ ...input, transactionIds: ['PN-2'] }); // next sync tick, same pattern

  const rows = await db.select().from(monitorRecords).all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.tier, 'MONITOR');
  assert.equal(rows[0]!.riskScore, 50);
  assert.deepEqual(JSON.parse(rows[0]!.transactionIds), ['PN-1', 'PN-2']);

  assert.equal((await db.select().from(alerts).all()).length, 0);
  assert.equal((await listAlerts()).length, 0);
});

// Best-effort: Windows keeps the libsql file locked until the process exits (temp dir gets cleaned by the OS).
test.after(() => { try { rmSync(dbPath, { force: true }); } catch { /* locked */ } });
