import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentHistory } from './appsolute.service.js';
import type { BraintreeTransaction } from './braintree.service.js';

process.env['DB_PATH'] = join(tmpdir(), 'fraud-engine-test.db'); // engines import the db module; no queries run
const { evaluateFraud } = await import('./fraud-engine.service.js');
const { DEFAULT_SETTINGS } = await import('./settings.service.js');

const borrower = { borrowerId: 'B', loanId: 'L', expectedMonthlyPayment: 2500, loanStatus: 'ACTIVE' };
const t0 = Date.parse('2026-09-10T12:00:00.000Z');
const at = (i: number) => new Date(t0 + i * 60_000).toISOString(); // one payment per minute, same day

const pay = (i: number): PaymentHistory => ({
  transactionId: `t${i}`, amount: 2500, paymentMethod: `PN-${i}`, fundingSource: '411111-1001',
  createdAt: at(i), status: 'SETTLED', isRefund: false, isDispute: false,
});
const txFor = (i: number): BraintreeTransaction => ({
  id: `PN-${i}`, legacyId: `PN-${i}`, amount: { value: '2500.00', currencyCode: 'USD' },
  status: 'SUBMITTED_FOR_SETTLEMENT', createdAt: at(i),
});

test('a repeated suspicious pattern is not progressively suppressed by its own repetition', () => {
  const all = Array.from({ length: 6 }, (_, i) => pay(i));
  // Evaluate each new identical payment with the history known at that moment (as sync would).
  for (let i = 1; i < all.length; i++) {
    const r = evaluateFraud(txFor(i), all.slice(0, i + 1), 'US', 60, borrower, DEFAULT_SETTINGS);
    assert.equal(r.triggered, true, `occurrence #${i + 1} must still alert`);
    assert.deepEqual(r.signals.map((s) => s.rule), ['DUPLICATE_PAYMENT'], `occurrence #${i + 1}`);
    assert.equal(r.suppressed.length, 0, `occurrence #${i + 1} must not be suppressed`);
  }
});

test('genuinely established history (payments on distinct days) still suppresses a normal repeat', () => {
  const priorDays = Array.from({ length: 5 }, (_, i) => ({
    ...pay(100 + i), createdAt: new Date(t0 - (i + 1) * 4 * 86_400_000).toISOString(),
  }));
  const history = [...priorDays, pay(0), pay(1)]; // two identical charges today, but a real 6-day track record
  const r = evaluateFraud(txFor(1), history, 'US', 60, borrower, DEFAULT_SETTINGS);
  assert.equal(r.triggered, false);
  assert.equal(r.suppressed.length, 1);
});
