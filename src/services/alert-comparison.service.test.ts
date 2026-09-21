import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PaymentHistory } from './appsolute.service.js';

process.env['DB_PATH'] = join(tmpdir(), 'fraud-comparison-test.db'); // engines import the db module; no queries run
const { compareAlerting, formatSummary } = await import('./alert-comparison.service.js');
const { DEFAULT_CONFIGS } = await import('./aml-engine.service.js');
const { DEFAULT_SETTINGS } = await import('./settings.service.js');

const at = (hhmm: string) => `2026-09-10T${hhmm}:00.000`;
let n = 0;
const pay = (hhmm: string, amount: number, card: string, extra: Partial<PaymentHistory> = {}): PaymentHistory => ({
  transactionId: `t${n}`, amount, paymentMethod: `PN-${n++}`, fundingSource: card,
  createdAt: at(hhmm), status: 'SETTLED', isRefund: false, isDispute: false, ...extra,
});
const settle = (p: PaymentHistory) => ({ pnref: p.paymentMethod, amount: p.amount, settledAt: p.createdAt });
const borrower = (loanId: string) => ({ borrowerId: loanId, loanId, expectedMonthlyPayment: 1000, loanStatus: 'ACTIVE' });

// Loan A: four normal-sized payments the same day, one card → raw same-day velocity, suppressed as normal EMI behaviour
const a = [pay('10:00', 1000, 'c1'), pay('10:05', 1001, 'c1'), pay('10:10', 1002, 'c1'), pay('10:15', 1003, 'c1')];
// Loan B: three cards in one day, normal sizes → one real signal (25) → monitor tier, not an alert
const b = [pay('09:00', 1000, 'c1'), pay('10:00', 1001, 'c2'), pay('11:00', 1002, 'c3')];
// Loan C: 3 cards + $5000 payment + refund + dispute → correlated alert
const c1 = pay('09:00', 1000, 'c1', { isDispute: true });
const c2 = pay('10:00', 1001, 'c2');
const cRefund = pay('10:30', -1000, 'c2', { isRefund: true });
const c3 = pay('11:00', 5000, 'c3');
const c = [c1, c2, cRefund, c3];

const loans = [
  { borrower: borrower('A'), settlements: a.map(settle), history: a },
  { borrower: borrower('B'), settlements: b.map(settle), history: b },
  { borrower: borrower('C'), settlements: [c1, c2, c3].map(settle), history: c },
];

test('naive vs actual counts, reduction %, monitor, suppression and narrative coverage', () => {
  const s = compareAlerting(loans, DEFAULT_SETTINGS, DEFAULT_CONFIGS);
  console.log('\n' + formatSummary(s, 30));
  assert.equal(s.loans, 3);
  assert.equal(s.settlementsEvaluated, 10);
  assert.equal(s.naiveAlerts, 4);          // A: 3rd + 4th payment; B: 3rd; C: 3rd
  assert.equal(s.actualAlerts, 1);         // only loan C reaches 3+ correlated scenarios
  assert.equal(s.reductionPct, 75);
  assert.equal(s.actualDistinctAlerts, 1);
  assert.equal(s.monitorRecords, 1);       // loan B
  assert.equal(s.suppressedSignals, 3);    // A ×2, B ×1 same-day velocity
  assert.equal(s.alertsWithNarrative, 1);
  assert.equal(s.narrativePct, 100);
  assert.equal(s.examples.length, 1);
  assert.match(s.examples[0]!.narrative, /^Loan C: /);
  assert.match(formatSummary(s, 30), /Example summaries/);
  assert.deepEqual(s.byScenario['SAME_DAY_VELOCITY'], { naive: 4, actual: 1 });
});

test('history is truncated as-of each settlement (later refund does not leak into earlier evaluations)', () => {
  // With only loan C's first two settlements evaluated, no refund/dispute pair is visible yet.
  const s = compareAlerting([{ ...loans[2]!, settlements: [c1, c2].map(settle) }], DEFAULT_SETTINGS, DEFAULT_CONFIGS);
  assert.equal(s.naiveAlerts, 0);
});

test('no settlements → zero everything, no divide-by-zero', () => {
  const s = compareAlerting([], DEFAULT_SETTINGS, DEFAULT_CONFIGS);
  assert.equal(s.reductionPct, 0);
  assert.equal(s.narrativePct, 0);
});
