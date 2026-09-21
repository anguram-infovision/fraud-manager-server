/**
 * Demo scenarios: 12 synthetic loans, each engineered to hit one specific engine outcome.
 * Every alert / monitor record / suppression is produced by the REAL evaluateFraud / evaluateAml /
 * upsertAlert / recordMonitor code — only the INPUT (borrower history + transaction) is synthetic.
 * `expect` is the human-written expectation; `actual` always comes from the engines, so a mismatch
 * means behaviour changed. Driven by scripts/demo-seed.ts and covered by demo-scenarios.test.ts.
 */
import { and, eq, inArray, like } from 'drizzle-orm';
import { db } from '../db/index.js';
import { alerts, alertNotes, auditLog, monitorRecords, suppressionLog } from '../db/schema.js';
import type { BorrowerContext, PaymentHistory } from './appsolute.service.js';
import type { BraintreeTransaction } from './braintree.service.js';
import { evaluateAml, type ScenarioConfigs } from './aml-engine.service.js';
import { evaluateFraud } from './fraud-engine.service.js';
import { upsertAlert, getAlert } from './alerts.store.js';
import { recordMonitor } from './monitor.store.js';
import { logSuppressions } from './suppression-log.service.js';
import { buildNarrativeContext } from './narrative.service.js';
import { asOf } from './alert-comparison.service.js';
import type { SystemSettings } from './settings.service.js';

export type Outcome = 'NONE' | 'SUPPRESSED' | 'MONITOR' | 'ALERT' | 'COOLDOWN';

interface Fixture {
  loanId: string;
  history: PaymentHistory[];
  tx: BraintreeTransaction;
  borrowerCountry?: string;
  /** Evaluate + persist this many times (consecutive sync ticks). */
  repeat?: number;
}

export interface DemoScenario {
  n: number;
  name: string;
  expect: { outcome: Outcome; fired: string[]; suppressed: string[] };
  /** Where the engine's real behaviour differs from a naive reading of the scenario. */
  note?: string;
  /** Set when the scenario can only be produced by demo input — printed next to it so it is never presented as live-working. */
  demoOnly?: string;
  build: (base: number) => Fixture;
}

export interface ScenarioResult {
  n: number;
  name: string;
  loanId: string;
  expected: Outcome;
  actual: Outcome;
  fired: string[];
  suppressed: string[];
  match: boolean;
  narrative?: string | null;
  note?: string;
  demoOnly?: string;
}

const EMI = 2500;
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** Today at 12:00 local — keeps "same calendar day" scenarios independent of when the script runs. */
const baseTime = () => { const d = new Date(); d.setHours(12, 0, 0, 0); return d.getTime(); };
const iso = (base: number, daysAgo: number, hoursOffset = 0) => new Date(base - daysAgo * DAY + hoursOffset * HOUR).toISOString();
// Test BINs only (411111 = Visa test range); last4 is fake.
const card = (i: number) => `411111-100${i}`;

const pay = (loan: string, tag: string, amount: number, cardIdx: number, createdAt: string, extra: Partial<PaymentHistory> = {}): PaymentHistory => ({
  transactionId: `${loan}-T-${tag}`, amount, paymentMethod: `DEMO-PN-${loan}-${tag}`, fundingSource: card(cardIdx),
  createdAt, status: 'SETTLED', isRefund: false, isDispute: false, ...extra,
});

const mkTx = (loan: string, tag: string, amount: number, base: number, extra: Partial<BraintreeTransaction> = {}): BraintreeTransaction => ({
  id: `DEMO-PN-${loan}-${tag}`, legacyId: `DEMO-PN-${loan}-${tag}`, amount: { value: amount.toFixed(2), currencyCode: 'USD' },
  status: 'SUBMITTED_FOR_SETTLEMENT', createdAt: new Date(base).toISOString(), orderId: loan, ...extra,
});

/** The settlement being evaluated also appears in AFS history, exactly as on the live path. */
const rowFor = (loan: string, tx: BraintreeTransaction, tag: string, cardIdx: number) =>
  pay(loan, tag, Number(tx.amount.value), cardIdx, tx.createdAt);

/** 7 on-schedule payments, same card, every 4 days back → with the current one, a MATURE (≥6) baseline. */
const matureHistory = (loan: string, base: number) =>
  Array.from({ length: 7 }, (_, i) => pay(loan, `M${i}`, EMI, 1, iso(base, (i + 1) * 4)));

/** Two identical charges 2 minutes apart on different PNREFs, thin history (fraud duplicate). */
function duplicateFixture(loan: string, base: number): Fixture {
  const tx = mkTx(loan, 'B', EMI, base);
  const prior = pay(loan, 'A', EMI, 1, new Date(base - 2 * 60_000).toISOString());
  return { loanId: loan, tx, history: [prior, rowFor(loan, tx, 'B', 1)] };
}

/** Three payments over three days on three different cards; the current one on card 3. */
function rotationFixture(loan: string, base: number, amount: number): Fixture {
  const tx = mkTx(loan, 'C', amount, base);
  return { loanId: loan, tx, history: [pay(loan, 'A', EMI, 1, iso(base, 2)), pay(loan, 'B', EMI, 2, iso(base, 1)), rowFor(loan, tx, 'C', 3)] };
}

export const SCENARIOS: DemoScenario[] = [
  {
    n: 1, name: 'Normal payment, MATURE borrower',
    expect: { outcome: 'NONE', fired: [], suppressed: [] },
    build: (base) => { const l = 'DEMO-S01-NORMAL-MATURE'; const tx = mkTx(l, 'X', EMI, base); return { loanId: l, tx, history: [...matureHistory(l, base), rowFor(l, tx, 'X', 1)] }; },
  },
  {
    n: 2, name: 'Large principal payoff, MATURE borrower (3.2× expected)',
    expect: { outcome: 'SUPPRESSED', fired: [], suppressed: ['AMOUNT_DEVIATION'] },
    build: (base) => { const l = 'DEMO-S02-PAYOFF-MATURE'; const tx = mkTx(l, 'X', 8000, base); return { loanId: l, tx, history: [...matureHistory(l, base), rowFor(l, tx, 'X', 1)] }; },
  },
  {
    n: 3, name: 'Same large payment, NEW borrower',
    expect: { outcome: 'MONITOR', fired: ['AMOUNT_DEVIATION'], suppressed: [] },
    note: 'One signal = 25 points, below the 60 gate: recorded as monitor-only by design. An AML alert needs 3 correlated scenarios, which a thin-history borrower cannot produce (MPS/SDV/velocity need 3-6 payments).',
    build: (base) => { const l = 'DEMO-S03-PAYOFF-NEW'; const tx = mkTx(l, 'X', 8000, base); return { loanId: l, tx, history: [rowFor(l, tx, 'X', 1)] }; },
  },
  {
    n: 4, name: 'Genuine retry — same PNREF seen twice',
    expect: { outcome: 'NONE', fired: [], suppressed: [] },
    note: 'Self-exclusion by PNREF. The orderId-retry exclusion cannot fire on the live path: getPaymentHistory() does not populate orderId.',
    build: (base) => {
      const l = 'DEMO-S04-SAME-PNREF'; const tx = mkTx(l, 'X', EMI, base);
      return { loanId: l, tx, history: [pay(l, 'X0', EMI, 1, new Date(base - 60_000).toISOString(), { paymentMethod: tx.legacyId! }), rowFor(l, tx, 'X', 1)] };
    },
  },
  {
    n: 5, name: 'Real duplicate — two PNREFs, same amount, 2 min apart, thin history',
    expect: { outcome: 'ALERT', fired: ['DUPLICATE_PAYMENT'], suppressed: [] },
    build: (base) => duplicateFixture('DEMO-S05-DUP-FRAUD', base),
  },
  {
    n: 6, name: 'Gateway rejection',
    expect: { outcome: 'ALERT', fired: ['GATEWAY_REJECTION'], suppressed: [] },
    build: (base) => { const l = 'DEMO-S06-GATEWAY-REJECT'; return { loanId: l, tx: mkTx(l, 'X', EMI, base, { status: 'GATEWAY_REJECTED' }), history: matureHistory(l, base) }; },
  },
  {
    n: 7, name: 'Card BIN country ≠ borrower country',
    expect: { outcome: 'ALERT', fired: ['BIN_COUNTRY_MISMATCH'], suppressed: [] },
    demoOnly: 'DEMO-ONLY — not live-working: production hardcodes borrower country "US" and the BIN table maps only US test BINs, so this cannot trigger on real data until the BIN table is expanded.',
    build: (base) => {
      const l = 'DEMO-S07-BIN-MISMATCH';
      const tx = mkTx(l, 'X', EMI, base, { paymentMethodSnapshot: { bin: '411111', last4: '1001' } });
      return { loanId: l, tx, history: [...matureHistory(l, base), rowFor(l, tx, 'X', 1)], borrowerCountry: 'CA' };
    },
  },
  {
    n: 8, name: 'Biweekly / extra payer — 8 normal payments in 7 days, 3 today, MATURE',
    expect: { outcome: 'SUPPRESSED', fired: [], suppressed: ['PAYMENT_VELOCITY', 'SAME_DAY_VELOCITY'] },
    build: (base) => {
      const l = 'DEMO-S08-BIWEEKLY-EXTRA'; const tx = mkTx(l, 'X', EMI, base);
      const days = [1, 2, 3, 4, 5].map((d) => pay(l, `D${d}`, EMI, 1, iso(base, d)));
      const today = [pay(l, 'H6', EMI, 1, iso(base, 0, -6)), pay(l, 'H9', EMI, 1, iso(base, 0, -3))];
      return { loanId: l, tx, history: [...days, ...today, rowFor(l, tx, 'X', 1)] };
    },
  },
  {
    n: 9, name: 'Funding-source rotation — 3 distinct new cards in 3 days',
    expect: { outcome: 'MONITOR', fired: ['MULTIPLE_PAYMENT_SOURCES'], suppressed: [] },
    note: 'Single signal (25) → monitor-only by design; it needs two more correlated scenarios to become an alert (see #10 for two).',
    build: (base) => rotationFixture('DEMO-S09-CARD-ROTATION', base, EMI),
  },
  {
    n: 10, name: 'Two-signal correlation — 3.2× amount + 3 new cards',
    expect: { outcome: 'MONITOR', fired: ['AMOUNT_DEVIATION', 'MULTIPLE_PAYMENT_SOURCES'], suppressed: [] },
    build: (base) => rotationFixture('DEMO-S10-DEVIATION-PLUS-SOURCES', base, 8000),
  },
  {
    n: 11, name: 'Cooldown — scenario 5 condition on two consecutive syncs',
    expect: { outcome: 'COOLDOWN', fired: ['DUPLICATE_PAYMENT'], suppressed: [] },
    build: (base) => ({ ...duplicateFixture('DEMO-S11-COOLDOWN', base), repeat: 2 }),
  },
  {
    n: 12, name: 'Refund + dispute in the window',
    expect: { outcome: 'MONITOR', fired: ['REFUND_DISPUTE_CYCLE'], suppressed: [] },
    note: 'Known open gap: refund and dispute are not tied to the same payment — any refund plus any dispute in 30 days fires it. Single signal → monitor-only.',
    build: (base) => {
      const l = 'DEMO-S12-REFUND-DISPUTE'; const tx = mkTx(l, 'X', EMI, base);
      return { loanId: l, tx, history: [pay(l, 'P', EMI, 1, iso(base, 10), { isDispute: true }), pay(l, 'R', -EMI, 1, iso(base, 8), { isRefund: true }), rowFor(l, tx, 'X', 1)] };
    },
  },
];

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

// Mirrors the severity mapping inlined in sync.service.ts / webhook.router.ts.
const fraudSeverity = (score: number) => (score >= 60 ? 'HIGH' : 'MEDIUM');
const amlSeverity = (score: number) => (score >= 75 ? 'CRITICAL' : score >= 50 ? 'HIGH' : 'MEDIUM');

/** Removes previously seeded DEMO- data (all of it, or just the given loans) so runs are repeatable. */
export async function resetDemoData(loanIds?: string[]): Promise<void> {
  const byLoan = (col: typeof alerts.loanId) => (loanIds ? inArray(col, loanIds) : like(col, 'DEMO-%'));
  const ids = (await db.select({ id: alerts.id }).from(alerts).where(byLoan(alerts.loanId)).all()).map((r) => r.id);
  if (ids.length) {
    await db.delete(alertNotes).where(inArray(alertNotes.alertId, ids));
    await db.delete(auditLog).where(inArray(auditLog.alertId, ids));
  }
  await db.delete(alerts).where(byLoan(alerts.loanId));
  await db.delete(monitorRecords).where(byLoan(monitorRecords.loanId));
  await db.delete(suppressionLog).where(byLoan(suppressionLog.loanId));
}

export async function runScenario(s: DemoScenario, settings: SystemSettings, configs: ScenarioConfigs): Promise<ScenarioResult> {
  const base = baseTime();
  const f = s.build(base);
  const borrower: BorrowerContext = { borrowerId: f.loanId, loanId: f.loanId, expectedMonthlyPayment: EMI, loanStatus: 'ACTIVE' };
  const narrativeContext = buildNarrativeContext(borrower, f.history, settings, f.tx);
  const repeat = f.repeat ?? 1;

  let last!: { fraud: ReturnType<typeof evaluateFraud>; aml: ReturnType<typeof evaluateAml> };
  for (let i = 0; i < repeat; i++) {
    // Pin "now" to the transaction time so 7-day / same-day windows line up with the fixture.
    last = asOf(base, () => ({
      fraud: evaluateFraud(f.tx, f.history, f.borrowerCountry ?? 'US', 60, borrower, settings),
      aml: evaluateAml(f.tx, borrower, f.history, configs, settings),
    }));
    const { fraud, aml } = last;
    await logSuppressions(f.loanId, fraud.suppressed.map((x) => ({ scenario: x.rule, reason: x.reason, value: x.value })), 'FRAUD');
    await logSuppressions(f.loanId, aml.suppressed, 'AML');
    const common = { borrowerId: f.loanId, loanId: f.loanId, transactionIds: [f.tx.legacyId!], braintreeSignals: {}, narrativeContext };
    if (fraud.triggered) await upsertAlert({ ...common, type: 'FRAUD', severity: fraudSeverity(fraud.riskScore), riskScore: fraud.riskScore, signals: fraud.signals }, settings.cooldownMinutes);
    if (aml.triggered) await upsertAlert({ ...common, type: 'AML', severity: amlSeverity(aml.riskScore), riskScore: aml.riskScore, signals: aml.signals }, settings.cooldownMinutes);
    if (aml.monitor) await recordMonitor({ loanId: f.loanId, borrowerId: f.loanId, transactionIds: [f.tx.legacyId!], riskScore: aml.riskScore, signals: aml.signals });
  }

  const { fraud, aml } = last;
  const fired = [...fraud.signals.map((x) => x.rule), ...aml.signals.map((x) => x.scenario)];
  const suppressed = [...fraud.suppressed.map((x) => x.rule), ...aml.suppressed.map((x) => x.scenario)];
  const rows = await db.select().from(alerts).where(and(eq(alerts.loanId, f.loanId))).all();

  let actual: Outcome;
  if (repeat > 1) actual = rows.length === 1 && rows[0]!.recurrenceCount === repeat - 1 ? 'COOLDOWN' : 'ALERT';
  else if (fraud.triggered || aml.triggered) actual = 'ALERT';
  else if (aml.monitor) actual = 'MONITOR';
  else if (suppressed.length > 0) actual = 'SUPPRESSED';
  else actual = 'NONE';

  const stored = rows[0] ? await getAlert(rows[0].id) : null;
  return {
    n: s.n, name: s.name, loanId: f.loanId, expected: s.expect.outcome, actual, fired, suppressed,
    match: actual === s.expect.outcome && sameSet(fired, s.expect.fired) && sameSet(suppressed, s.expect.suppressed),
    narrative: stored?.narrative ?? null,
    ...(s.note && { note: s.note }),
    ...(s.demoOnly && { demoOnly: s.demoOnly }),
  };
}
