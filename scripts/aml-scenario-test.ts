/**
 * AML scenario unit test — exercises all 5 scenarios plus the correlation gate and
 * suppression rules with crafted data. No server running required. No DB or BT
 * connection needed.
 *
 * Usage: npx tsx scripts/aml-scenario-test.ts
 */
import { evaluateAml, DEFAULT_CONFIGS } from '../src/services/aml-engine.service.js';
import { DEFAULT_SETTINGS } from '../src/services/settings.service.js';
import type { BorrowerContext, PaymentHistory } from '../src/services/appsolute.service.js';
import type { BraintreeTransaction } from '../src/services/braintree.service.js';

const now = new Date();
const daysAgo = (n: number) => new Date(now.getTime() - n * 86_400_000).toISOString();

const baseTx: BraintreeTransaction = {
  id: 'test-tx',
  legacyId: '12345',
  status: 'SUBMITTED_FOR_SETTLEMENT',
  amount: { value: '1000.00', currencyCode: 'USD' },
  createdAt: now.toISOString(),
  orderId: null,
  paymentMethodSnapshot: { last4: '1881', bin: '401288', expirationMonth: '12', expirationYear: '2027', cardholderName: null },
  statusHistory: [],
  riskData: null,
};

const baseBorrower: BorrowerContext = {
  borrowerId: 'TEST-001',
  loanId: 'TEST-001',
  expectedMonthlyPayment: 1500,
  loanStatus: 'ACTIVE',
};

function mkPayment(overrides: Partial<PaymentHistory>, i = 0): PaymentHistory {
  return {
    transactionId: `txn-${i}`,
    amount: 1500,
    paymentMethod: 'ACH-001',
    createdAt: daysAgo(i),
    status: 'SETTLED',
    isRefund: false,
    isDispute: false,
    ...overrides,
  };
}

let pass = 0, fail = 0;
function check(scenario: string, result: ReturnType<typeof evaluateAml>, expectTriggered: boolean) {
  const hit = result.signals.some(s => s.scenario === scenario);
  const ok = hit === expectTriggered;
  console.log(`${ok ? '✓' : '✗'} ${scenario.padEnd(28)} signal=${String(hit).padEnd(5)} expected=${expectTriggered}`);
  if (!ok) {
    console.log('  signals:', JSON.stringify(result.signals, null, 2));
    fail++;
  } else {
    if (hit) console.log(`  → ${result.signals.find(s => s.scenario === scenario)?.description}`);
    pass++;
  }
}

function checkSuppressed(label: string, result: ReturnType<typeof evaluateAml>, scenario: string, expectSuppressed: boolean) {
  const hit = result.suppressed.some(s => s.scenario === scenario);
  const ok = hit === expectSuppressed;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(28)} suppressed=${String(hit).padEnd(5)} expected=${expectSuppressed}`);
  if (!ok) {
    console.log('  suppressed:', JSON.stringify(result.suppressed, null, 2));
    fail++;
  } else {
    if (hit) console.log(`  → ${result.suppressed.find(s => s.scenario === scenario)?.reason}`);
    pass++;
  }
}

function checkAlert(label: string, result: ReturnType<typeof evaluateAml>, expectTriggered: boolean) {
  const ok = result.triggered === expectTriggered;
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(28)} alert=${String(result.triggered).padEnd(5)} (score=${result.riskScore}) expected=${expectTriggered}`);
  if (!ok) fail++; else pass++;
}

console.log('\n=== AML Scenario Tests ===\n');

// ── MULTIPLE_PAYMENT_SOURCES ────────────────────────────────────────────────
const mpsHistory = [
  mkPayment({ paymentMethod: 'ACH-001' }, 1),
  mkPayment({ paymentMethod: 'ACH-002' }, 2),
  mkPayment({ paymentMethod: 'CARD-003' }, 3),
];
check('MULTIPLE_PAYMENT_SOURCES', evaluateAml(baseTx, baseBorrower, mpsHistory), true);
check('MULTIPLE_PAYMENT_SOURCES', evaluateAml(baseTx, baseBorrower, [mkPayment({ paymentMethod: 'ACH-001' })]), false);

// ── PAYMENT_VELOCITY — normal-sized repeats now suppressed, not flagged ───────
const pvNormalHistory = Array.from({ length: 7 }, (_, i) => mkPayment({}, i)); // 7 payments at exactly the EMI amount
check('PAYMENT_VELOCITY', evaluateAml(baseTx, baseBorrower, pvNormalHistory), false);
checkSuppressed('PAYMENT_VELOCITY (normal EMI×7)', evaluateAml(baseTx, baseBorrower, pvNormalHistory), 'PAYMENT_VELOCITY', true);
check('PAYMENT_VELOCITY', evaluateAml(baseTx, baseBorrower, pvNormalHistory.slice(0, 4)), false);

// High velocity WITH an abnormally large payment in the mix should still flag.
const pvAbnormalHistory = [
  ...Array.from({ length: 6 }, (_, i) => mkPayment({}, i)),
  mkPayment({ amount: 5000 }, 6),
];
check('PAYMENT_VELOCITY', evaluateAml(baseTx, baseBorrower, pvAbnormalHistory), true);

// ── SAME_DAY_VELOCITY — 2-3x EMI same day is normal, not flagged ─────────────
const sdvNormalHistory = [
  mkPayment({ createdAt: now.toISOString() }, 0),
  mkPayment({ createdAt: now.toISOString() }, 1),
  mkPayment({ createdAt: now.toISOString() }, 2),
];
check('SAME_DAY_VELOCITY', evaluateAml(baseTx, baseBorrower, sdvNormalHistory), false);
checkSuppressed('SAME_DAY_VELOCITY (2x EMI same day)', evaluateAml(baseTx, baseBorrower, sdvNormalHistory), 'SAME_DAY_VELOCITY', true);

// ── AMOUNT_DEVIATION ────────────────────────────────────────────────────────
const bigTx = { ...baseTx, amount: { value: '4000.00', currencyCode: 'USD' } }; // > 2×1500
const normalTx = { ...baseTx, amount: { value: '2000.00', currencyCode: 'USD' } }; // = 2×1500 exactly (not >)
check('AMOUNT_DEVIATION', evaluateAml(bigTx, baseBorrower, []), true); // NEW borrower, no history → not suppressed
check('AMOUNT_DEVIATION', evaluateAml(normalTx, baseBorrower, []), false);

// MATURE borrower (6+ payments) making one large payment → suppressed (likely principal payoff)
const matureHistory = Array.from({ length: 6 }, (_, i) => mkPayment({}, i + 1));
check('AMOUNT_DEVIATION', evaluateAml(bigTx, baseBorrower, matureHistory), false);
checkSuppressed('AMOUNT_DEVIATION (MATURE, 1 large pmt)', evaluateAml(bigTx, baseBorrower, matureHistory), 'AMOUNT_DEVIATION', true);

// ── REFUND_DISPUTE_CYCLE ────────────────────────────────────────────────────
const rdcHistory = [
  mkPayment({ isRefund: true, amount: -1500 }, 5),
  mkPayment({ isDispute: true }, 3),
];
check('REFUND_DISPUTE_CYCLE', evaluateAml(baseTx, baseBorrower, rdcHistory), true);
check('REFUND_DISPUTE_CYCLE', evaluateAml(baseTx, baseBorrower, [mkPayment({ isRefund: true, amount: -1500 })]), false);
check('REFUND_DISPUTE_CYCLE', evaluateAml(baseTx, baseBorrower, [mkPayment({ isDispute: true })]), false);

console.log('\n=== Correlation Gate (score ≥ amlAlertThreshold) ===\n');

// A single scenario alone (score 25) must never create an alert, even though the
// signal is recorded — this is the core fix for the false-positive complaint.
checkAlert('Single signal (MPS only)', evaluateAml(baseTx, baseBorrower, mpsHistory), false);

// Two correlated signals (score 50) still under the default 60 threshold.
const twoSignalHistory = [...mpsHistory, mkPayment({ isRefund: true, amount: -1500 }, 5), mkPayment({ isDispute: true }, 3)];
checkAlert('Two correlated signals (score 50)', evaluateAml(baseTx, baseBorrower, twoSignalHistory), false);

// Three correlated signals (score 75) crosses the threshold → alert.
const threeSignalHistory = [...twoSignalHistory];
const threeSignalTx = { ...bigTx };
checkAlert('Three correlated signals (score 75)', evaluateAml(threeSignalTx, baseBorrower, threeSignalHistory), true);

console.log('\n=== Suppression can be disabled via settings ===\n');
const settingsNoSuppression = { ...DEFAULT_SETTINGS, suppressionsEnabled: false };
check(
  'PAYMENT_VELOCITY',
  evaluateAml(baseTx, baseBorrower, pvNormalHistory, DEFAULT_CONFIGS, settingsNoSuppression),
  true
);

console.log(`\n${pass + fail} tests — ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
