/**
 * AML scenario unit test — exercises all 4 scenarios with crafted data.
 * No server running required. No DB or BT connection needed.
 *
 * Usage: npx tsx scripts/aml-scenario-test.ts
 */
import { evaluateAml, DEFAULT_CONFIGS } from '../src/services/aml-engine.service.js';
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
  console.log(`${ok ? '✓' : '✗'} ${scenario.padEnd(28)} triggered=${String(hit).padEnd(5)} expected=${expectTriggered}`);
  if (!ok) {
    console.log('  signals:', JSON.stringify(result.signals, null, 2));
    fail++;
  } else {
    if (hit) console.log(`  → ${result.signals.find(s => s.scenario === scenario)?.description}`);
    pass++;
  }
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

// ── PAYMENT_VELOCITY ────────────────────────────────────────────────────────
const pvHistory = Array.from({ length: 7 }, (_, i) => mkPayment({}, i)); // 7 payments in 7 days
check('PAYMENT_VELOCITY', evaluateAml(baseTx, baseBorrower, pvHistory), true);
check('PAYMENT_VELOCITY', evaluateAml(baseTx, baseBorrower, pvHistory.slice(0, 4)), false);

// ── AMOUNT_DEVIATION ────────────────────────────────────────────────────────
const bigTx = { ...baseTx, amount: { value: '4000.00', currencyCode: 'USD' } }; // > 2×1500
const normalTx = { ...baseTx, amount: { value: '2000.00', currencyCode: 'USD' } }; // = 2×1500 exactly (not >)
check('AMOUNT_DEVIATION', evaluateAml(bigTx, baseBorrower, []), true);
check('AMOUNT_DEVIATION', evaluateAml(normalTx, baseBorrower, []), false);

// ── REFUND_DISPUTE_CYCLE ────────────────────────────────────────────────────
const rdcHistory = [
  mkPayment({ isRefund: true, amount: -1500 }, 5),
  mkPayment({ isDispute: true }, 3),
];
check('REFUND_DISPUTE_CYCLE', evaluateAml(baseTx, baseBorrower, rdcHistory), true);
check('REFUND_DISPUTE_CYCLE', evaluateAml(baseTx, baseBorrower, [mkPayment({ isRefund: true, amount: -1500 })]), false);
check('REFUND_DISPUTE_CYCLE', evaluateAml(baseTx, baseBorrower, [mkPayment({ isDispute: true })]), false);

console.log(`\n${pass + fail} tests — ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
