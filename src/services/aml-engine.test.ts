import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentHistory } from './appsolute.service.js';
import type { BraintreeTransaction } from './braintree.service.js';

process.env['DB_PATH'] = join(tmpdir(), 'fraud-aml-test.db'); // engine imports the db module; no queries run here
const { evaluateAml } = await import('./aml-engine.service.js');
const { DEFAULT_SETTINGS } = await import('./settings.service.js');

const borrower = { borrowerId: 'L1', loanId: 'L1', expectedMonthlyPayment: 2500, loanStatus: 'ACTIVE' };
const tx = {
  id: 'tx', legacyId: 'PN-current', amount: { value: '2500.00', currencyCode: 'USD' },
  status: 'SETTLED', createdAt: new Date().toISOString(),
} as BraintreeTransaction;

const day = 86_400_000;
let seq = 0;
// paymentMethod is always a unique PNREF, exactly as getPaymentHistory() returns it.
const pay = (daysAgo: number, fundingSource?: string): PaymentHistory => ({
  transactionId: `t${seq}`, amount: 2500, paymentMethod: `PNREF-${seq++}`,
  ...(fundingSource && { fundingSource }),
  createdAt: new Date(Date.now() - daysAgo * day).toISOString(),
  status: 'SETTLED', isRefund: false, isDispute: false,
});

const fired = (h: PaymentHistory[]) =>
  evaluateAml(tx, borrower, h).signals.some((s) => s.scenario === 'MULTIPLE_PAYMENT_SOURCES');

test('5 payments in 30d from 1-2 cards (5 distinct PNREFs) does NOT fire', () => {
  const h = [pay(1, '411111-1111'), pay(3, '411111-1111'), pay(9, '411111-1111'), pay(15, '510510-5100'), pay(22, '510510-5100')];
  assert.equal(new Set(h.map((x) => x.paymentMethod)).size, 5);
  assert.equal(fired(h), false);
});

test('3 distinct, previously-unseen sources in the window DOES fire', () => {
  const h = [pay(1, '411111-1111'), pay(2, '510510-5100'), pay(3, '378282-0005'), pay(4, '411111-1111')];
  assert.equal(fired(h), true);
});

test('sources outside windowDays are not counted', () => {
  const h = [pay(1, '411111-1111'), pay(2, '510510-5100'), pay(10, '378282-0005'), pay(12, '601111-1117')];
  assert.equal(fired(h), false);
});

test('unresolved funding sources are not counted as distinct', () => {
  assert.equal(fired([pay(1), pay(2), pay(3), pay(4)]), false);
});

test('3 sources all seen earlier by an ESTABLISHED/MATURE borrower is suppressed and reported', () => {
  const h = [
    pay(1, '411111-1111'), pay(2, '510510-5100'), pay(3, '378282-0005'),
    pay(10, '411111-1111'), pay(17, '510510-5100'), pay(24, '378282-0005'),
  ];
  const r = evaluateAml(tx, borrower, h);
  assert.equal(r.signals.some((s) => s.scenario === 'MULTIPLE_PAYMENT_SOURCES'), false);
  const s = r.suppressed.find((x) => x.scenario === 'MULTIPLE_PAYMENT_SOURCES');
  assert.ok(s && s.reason.length > 0);
});

test('suppression respects suppressionsEnabled=false', () => {
  const h = [
    pay(1, '411111-1111'), pay(2, '510510-5100'), pay(3, '378282-0005'),
    pay(10, '411111-1111'), pay(17, '510510-5100'), pay(24, '378282-0005'),
  ];
  const settings = { ...DEFAULT_SETTINGS, suppressionsEnabled: false };
  const r = evaluateAml(tx, borrower, h, undefined, settings);
  assert.equal(r.signals.some((x) => x.scenario === 'MULTIPLE_PAYMENT_SOURCES'), true);
});

test('maturity counts distinct payment DAYS — a same-day burst does not build a track record', async () => {
  const { getBaselineMaturity } = await import('./aml-engine.service.js');
  const burst = Array.from({ length: 8 }, (_, i) => ({ ...pay(0, '411111-1111'), createdAt: new Date(Date.now() - i * 60_000).toISOString() }));
  assert.equal(getBaselineMaturity(burst, DEFAULT_SETTINGS), 'INSUFFICIENT_HISTORY');
  const spread = Array.from({ length: 6 }, (_, i) => pay(i, '411111-1111'));
  assert.equal(getBaselineMaturity(spread, DEFAULT_SETTINGS), 'MATURE');
});

test('same-day velocity reports the true count (history already includes the current payment)', () => {
  const three = [pay(0, '411111-1111'), pay(0, '411111-1111'), pay(0, '411111-1111')];
  const suppressed = evaluateAml(tx, borrower, three);
  const s = suppressed.suppressed.find((x) => x.scenario === 'SAME_DAY_VELOCITY');
  assert.equal(s?.value, 3);
  assert.match(s!.reason, /^3 same-day payments/);

  const fired = evaluateAml(tx, borrower, three, undefined, { ...DEFAULT_SETTINGS, suppressionsEnabled: false });
  const f = fired.signals.find((x) => x.scenario === 'SAME_DAY_VELOCITY');
  assert.equal(f?.value, 3);
  assert.match(f!.description, /^3 payments on loan/);
});
