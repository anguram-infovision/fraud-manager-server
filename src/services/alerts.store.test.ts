import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dbPath = join(tmpdir(), `fraud-alerts-test-${process.pid}.db`);
process.env['DB_PATH'] = dbPath;
const { db } = await import('../db/index.js');
const { alerts } = await import('../db/schema.js');
const { migrate } = await import('drizzle-orm/libsql/migrator');
const { upsertAlert, updateAlertStatus } = await import('./alerts.store.js');
const { eq } = await import('drizzle-orm');

await migrate(db, { migrationsFolder: './drizzle' });

const sig = (scenario: string) => ({ scenario, description: scenario, value: 1, threshold: 1 });
const aml = (loanId: string, scenarios: string[], txId: string) => ({
  type: 'AML', severity: 'HIGH', borrowerId: 'B1', loanId, transactionIds: [txId],
  riskScore: scenarios.length * 25, signals: scenarios.map(sig), braintreeSignals: {},
});
const rows = (loanId: string) => db.select().from(alerts).where(eq(alerts.loanId, loanId)).all();
const THREE = ['AMOUNT_DEVIATION', 'MULTIPLE_PAYMENT_SOURCES', 'REFUND_DISPUTE_CYCLE'];

test('same condition on two consecutive syncs → one alert row', async () => {
  await upsertAlert(aml('L-consec', THREE, 'PN-1'), 60);
  await upsertAlert(aml('L-consec', THREE, 'PN-2'), 60);
  const r = await rows('L-consec');
  assert.equal(r.length, 1);
  assert.equal(r[0]!.recurrenceCount, 1);
  assert.deepEqual(JSON.parse(r[0]!.transactionIds), ['PN-1', 'PN-2']);
});

test('alert already UNDER_REVIEW / ESCALATED still absorbs re-fires (no duplicate OPEN alert)', async () => {
  for (const status of ['UNDER_REVIEW', 'ESCALATED']) {
    const loan = `L-${status}`;
    const first = await upsertAlert(aml(loan, THREE, 'PN-1'), 60);
    await updateAlertStatus(first!.id, status);
    await upsertAlert(aml(loan, THREE, 'PN-2'), 60);
    const r = await rows(loan);
    assert.equal(r.length, 1, status);
    assert.equal(r[0]!.status, status);
    assert.equal(r[0]!.recurrenceCount, 1);
  }
});

test('after the cooldown window has elapsed a new alert is created', async () => {
  const first = await upsertAlert(aml('L-expired', THREE, 'PN-1'), 60);
  await updateAlertStatus(first!.id, 'UNDER_REVIEW');
  const old = new Date(Date.now() - 61 * 60_000).toISOString();
  await db.update(alerts).set({ lastSeenAt: old }).where(eq(alerts.id, first!.id));
  await upsertAlert(aml('L-expired', THREE, 'PN-2'), 60);
  assert.equal((await rows('L-expired')).length, 2);
});

test('cooldownMinutes = 0 disables the cooldown for non-OPEN alerts', async () => {
  const first = await upsertAlert(aml('L-zero', THREE, 'PN-1'), 0);
  await updateAlertStatus(first!.id, 'UNDER_REVIEW');
  await upsertAlert(aml('L-zero', THREE, 'PN-2'), 0);
  assert.equal((await rows('L-zero')).length, 2);
});

test('different loans and different types are independent', async () => {
  await upsertAlert(aml('L-a', THREE, 'PN-1'), 60);
  await upsertAlert(aml('L-b', THREE, 'PN-2'), 60);
  await upsertAlert({ ...aml('L-a', [], 'PN-3'), type: 'FRAUD', signals: [{ rule: 'GATEWAY_REJECTION', description: '', value: 'x' }], riskScore: 30 }, 60);
  assert.equal((await rows('L-a')).length, 2);
  assert.equal((await rows('L-b')).length, 1);
});

// Best-effort: Windows keeps the libsql file locked until the process exits (temp dir gets cleaned by the OS).
test.after(() => { try { rmSync(dbPath, { force: true }); } catch { /* locked */ } });

