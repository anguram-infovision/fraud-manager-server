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

const pay = (i: number, amount = 2500): PaymentHistory => ({
  transactionId: `t${i}`, amount, paymentMethod: `PN-${i}`, fundingSource: '411111-1001',
  createdAt: at(i), status: 'SETTLED', isRefund: false, isDispute: false,
});
const txFor = (i: number, amount = 2500): BraintreeTransaction => ({
  id: `PN-${i}`, legacyId: `PN-${i}`, amount: { value: amount.toFixed(2), currencyCode: 'USD' },
  status: 'SUBMITTED_FOR_SETTLEMENT', createdAt: at(i),
});

test('a repeated suspicious pattern is not progressively suppressed by its own repetition', () => {
  // Not a clean multiple of the $2,500 EMI at any repeat count 2-6 (see catchUpMultiplier) —
  // isolates this from the separate catch-up suppression covered below.
  const AMOUNT = 4123.57;
  const all = Array.from({ length: 6 }, (_, i) => pay(i, AMOUNT));
  // Evaluate each new identical payment with the history known at that moment (as sync would).
  for (let i = 1; i < all.length; i++) {
    const r = evaluateFraud(txFor(i, AMOUNT), all.slice(0, i + 1), 'US', 60, borrower, DEFAULT_SETTINGS);
    assert.equal(r.triggered, true, `occurrence #${i + 1} must still alert`);
    assert.deepEqual(r.signals.map((s) => s.rule), ['DUPLICATE_PAYMENT'], `occurrence #${i + 1}`);
    assert.equal(r.suppressed.length, 0, `occurrence #${i + 1} must not be suppressed`);
  }
});

test('3 identical payments summing to exactly 3× expected monthly payment are suppressed as catch-up', () => {
  const history = [pay(0), pay(1), pay(2)]; // 3× $2,500 = $7,500 = 3× the $2,500 EMI, thin history
  const r = evaluateFraud(txFor(2), history, 'US', 60, borrower, DEFAULT_SETTINGS);
  assert.equal(r.triggered, false);
  assert.equal(r.suppressed.length, 1);
  assert.equal(r.suppressed[0]!.rule, 'DUPLICATE_PAYMENT');
  assert.equal(r.suppressed[0]!.value, 3);
  assert.match(r.suppressed[0]!.reason, /3 payments of \$2500\.00 sum to 3× the expected monthly payment/);
  assert.match(r.suppressed[0]!.reason, /catch-up payment, not duplicate charge/);
});

test('2 identical payments with no clean-multiple relationship still fire, unaffected by this change', () => {
  // Two $2,500 charges with no wider context establishing "catching up" — the base 2-occurrence
  // duplicate-fraud trigger must not be raised by the new catch-up rule (which only applies at 3+).
  const history = [pay(0), pay(1)];
  const r = evaluateFraud(txFor(1), history, 'US', 60, borrower, DEFAULT_SETTINGS);
  assert.equal(r.triggered, true);
  assert.deepEqual(r.signals.map((s) => s.rule), ['DUPLICATE_PAYMENT']);
  assert.equal(r.signals[0]!.value, 2);
  assert.equal(r.suppressed.length, 0);
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
