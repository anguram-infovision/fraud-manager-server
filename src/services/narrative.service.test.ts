import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentHistory } from './appsolute.service.js';
import type { BraintreeTransaction } from './braintree.service.js';

process.env['DB_PATH'] = join(tmpdir(), 'fraud-narrative-test.db'); // engine imports db module; no queries run
const { generateAlertNarrative, renderNarrative } = await import('./narrative.service.js');
const { evaluateAml } = await import('./aml-engine.service.js');
const { evaluateFraud } = await import('./fraud-engine.service.js');
const { DEFAULT_SETTINGS } = await import('./settings.service.js');

const borrower = { borrowerId: 'B1', loanId: 'LOAN-100', expectedMonthlyPayment: 2500, loanStatus: 'ACTIVE' };
const day = 86_400_000;
const pay = (i: number, fundingSource: string): PaymentHistory => ({
  transactionId: `t${i}`, amount: 2500, paymentMethod: `PNREF-${i}`, fundingSource,
  createdAt: new Date(Date.now() - i * day).toISOString(), status: 'SETTLED', isRefund: false, isDispute: false,
});
const mkTx = (amount: string, status = 'SETTLED'): BraintreeTransaction =>
  ({ id: 'x', legacyId: 'PN-x', amount: { value: amount, currencyCode: 'USD' }, status, createdAt: new Date().toISOString() });

// No raw enum names (AMOUNT_DEVIATION, GATEWAY_REJECTED, ...) may leak into the text.
const noEnums = (text: string) => assert.doesNotMatch(text, /\b[A-Z]{2,}(?:_[A-Z]+)+\b/);

test('correlated AML alert (AMOUNT_DEVIATION + MULTIPLE_PAYMENT_SOURCES) reads as a coherent paragraph', () => {
  const history = [pay(1, '411111-1111'), pay(2, '510510-5100'), pay(3, '378282-0005')];
  const tx = mkTx('8000.00');
  const aml = evaluateAml(tx, borrower, history);
  assert.deepEqual(aml.signals.map((s) => s.scenario).sort(), ['AMOUNT_DEVIATION', 'MULTIPLE_PAYMENT_SOURCES']);

  const text = generateAlertNarrative({ type: 'AML', signals: aml.signals }, borrower, history, DEFAULT_SETTINGS, tx);
  console.log('\n  AML narrative:', text);
  assert.match(text, /^Loan LOAN-100: Expected payment is \$2,500\.00\/month, and the borrower has an established payment history \(3 payments in the last 30 days\)\./);
  assert.match(text, /triggering payment was \$8,000\.00/);
  assert.match(text, /3 different cards or funding sources/);
  assert.match(text, /\$8,000\.00 is far above the expected monthly amount \(3\.2× the expected amount\)/);
  assert.match(text, /Flagged: multiple payment sources, unusual payment amount\.$/);
  noEnums(text);
});

test('standalone GATEWAY_REJECTION fraud alert reads as a coherent paragraph', () => {
  const tx = mkTx('2500.00', 'GATEWAY_REJECTED');
  const fraud = evaluateFraud(tx, [], 'US', 60, borrower);
  assert.deepEqual(fraud.signals.map((s) => s.rule), ['GATEWAY_REJECTION']);

  const text = generateAlertNarrative({ type: 'FRAUD', signals: fraud.signals }, borrower, [], DEFAULT_SETTINGS, tx);
  console.log('\n  Fraud narrative:', text);
  assert.match(text, /no prior payment history \(0 payments in the last 30 days\)\./);
  assert.doesNotMatch(text, /reliable baseline/); // per-transaction fraud alert: baseline caveat not needed
  assert.match(text, /This transaction was flagged because the payment gateway rejected the transaction\./);
  assert.match(text, /Flagged: gateway rejection\.$/);
  noEnums(text);
});

test('BIN country mismatch and unknown baseline are phrased in plain terms', () => {
  const text = generateAlertNarrative(
    { type: 'FRAUD', signals: [{ rule: 'BIN_COUNTRY_MISMATCH', description: '', value: 'GB vs US' }] },
    { ...borrower, expectedMonthlyPayment: 0 }, [], DEFAULT_SETTINGS);
  assert.match(text, /Expected monthly payment is not known/);
  assert.match(text, /card was issued in GB while the borrower is based in US/);
  noEnums(text);
});

test('AML narrative for a NEW / thin-history borrower states the low-confidence caveat', () => {
  const signals = [{ scenario: 'AMOUNT_DEVIATION', description: '', value: '8000.00', threshold: '5000.00' }];
  for (const [maturity, paymentCount] of [['NEW', 0], ['INSUFFICIENT_HISTORY', 1]] as const) {
    const text = renderNarrative('AML', signals, { loanId: 'L', expectedMonthlyPayment: 2500, maturity, paymentCount });
    assert.match(text, /not enough history to establish a reliable baseline/, maturity);
  }
  const established = renderNarrative('AML', signals, { loanId: 'L', expectedMonthlyPayment: 2500, maturity: 'ESTABLISHED', paymentCount: 4 });
  assert.doesNotMatch(established, /reliable baseline/);
});

test('a DUPLICATE_PAYMENT signal that matches a clean catch-up multiple reads as catch-up, not duplicate-charge suspicion', () => {
  // Suppressed catch-up cases don't normally reach the narrative (suppression happens before an
  // alert exists) — this covers the defensive case where one shows up unsuppressed anyway (e.g.
  // a monitor/review state, or suppressionsEnabled off) so it's still described accurately.
  const ctx = { loanId: 'L', expectedMonthlyPayment: 2500, maturity: 'NEW' as const, paymentCount: 3, amount: 2500 };
  const catchUp = renderNarrative('FRAUD', [{ rule: 'DUPLICATE_PAYMENT', description: '', value: 3 }], ctx);
  assert.match(catchUp, /appears to be a multi-month catch-up payment, settling roughly 3 months at once/);
  assert.doesNotMatch(catchUp, /submitted 3 times/);

  // Not a clean multiple (2 payments, or an amount unrelated to the EMI) — old phrasing stands.
  const notCatchUp = renderNarrative('FRAUD', [{ rule: 'DUPLICATE_PAYMENT', description: '', value: 2 }], ctx);
  assert.match(notCatchUp, /the same amount was submitted 2 times within a short time/);
});
