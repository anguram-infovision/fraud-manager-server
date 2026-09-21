import type { BorrowerContext, PaymentHistory } from './appsolute.service.js';
import type { BraintreeTransaction } from './braintree.service.js';
import { DEFAULT_SETTINGS, type SystemSettings } from './settings.service.js';
import { db } from '../db/index.js';
import { scenarioConfigs } from '../db/schema.js';

export interface AmlRiskSignal {
  scenario: string;
  description: string;
  value: string | number;
  threshold: string | number;
}

export interface SuppressedSignal {
  scenario: string;
  reason: string;
  value: string | number;
}

export interface AmlEvaluation {
  triggered: boolean;
  /** Below the alert threshold but ≥ MONITOR_MIN_SCORE — recorded as a monitor-tier record, not an alert. */
  monitor: boolean;
  riskScore: number;
  signals: AmlRiskSignal[];
  suppressed: SuppressedSignal[];
}

/** Lowest AML score worth recording (one fired scenario = 25). */
export const MONITOR_MIN_SCORE = 25;

export interface ScenarioConfig {
  enabled: boolean;
  parameters: Record<string, number>;
  severity: string;
}

export type ScenarioConfigs = Record<string, ScenarioConfig>;

export type BaselineMaturity = 'NEW' | 'INSUFFICIENT_HISTORY' | 'ESTABLISHED' | 'MATURE';

export const DEFAULT_CONFIGS: ScenarioConfigs = {
  MULTIPLE_PAYMENT_SOURCES: {
    enabled: true,
    parameters: { minimumSources: 3, windowDays: 7 },
    severity: 'HIGH',
  },
  PAYMENT_VELOCITY: {
    enabled: true,
    parameters: { maxPayments: 5, windowDays: 7 },
    severity: 'MEDIUM',
  },
  AMOUNT_DEVIATION: {
    enabled: true,
    parameters: { deviationMultiplier: 2 },
    severity: 'HIGH',
  },
  REFUND_DISPUTE_CYCLE: {
    enabled: true,
    parameters: { minCycleCount: 1 },
    severity: 'CRITICAL',
  },
  SAME_DAY_VELOCITY: {
    enabled: true,
    parameters: { maxPayments: 2 },
    severity: 'MEDIUM',
  },
};

/**
 * Number of distinct calendar days on which the loan had a settled (non-refund) payment.
 * Maturity is measured in payment DAYS, not raw payments: a burst of identical charges within
 * minutes is one day of history, so a repeated suspicious pattern cannot vouch for itself by
 * "establishing" the track record that would then suppress it.
 */
export function countPaymentDays(history: PaymentHistory[]): number {
  return new Set(history.filter((h) => !h.isRefund).map((h) => h.createdAt.slice(0, 10))).size;
}

/**
 * Per PROJECT.md Section 5 — a borrower with MATURE history (matureLoanPaymentCount+
 * settled payments) should be evaluated against their own baseline, not a static
 * threshold. NEW/INSUFFICIENT_HISTORY borrowers should only trigger on high-confidence
 * signals (we don't relax anything for them here — just don't apply maturity-based
 * suppression, which requires established history to be meaningful).
 */
export function getBaselineMaturity(history: PaymentHistory[], settings: SystemSettings): BaselineMaturity {
  const paymentDays = countPaymentDays(history);
  if (paymentDays >= settings.matureLoanPaymentCount) return 'MATURE';
  if (paymentDays >= settings.establishedLoanPaymentCount) return 'ESTABLISHED';
  if (paymentDays >= 1) return 'INSUFFICIENT_HISTORY';
  return 'NEW';
}

/**
 * Reads persisted scenario overrides (see scenarios.router.ts) — falls back to
 * DEFAULT_CONFIGS for any scenario without a saved row.
 */
export async function getScenarioConfigs(): Promise<ScenarioConfigs> {
  const rows = await db.select().from(scenarioConfigs).all();
  if (rows.length === 0) return DEFAULT_CONFIGS;
  const overrides = Object.fromEntries(
    rows.map((r) => [r.scenario, { enabled: r.enabled, parameters: JSON.parse(r.parameters) as Record<string, number>, severity: r.severity }])
  );
  return { ...DEFAULT_CONFIGS, ...overrides };
}

export function evaluateAml(
  tx: BraintreeTransaction,
  borrower: BorrowerContext,
  history: PaymentHistory[],
  configs: ScenarioConfigs = DEFAULT_CONFIGS,
  settings: SystemSettings = DEFAULT_SETTINGS
): AmlEvaluation {
  const signals: AmlRiskSignal[] = [];
  const suppressed: SuppressedSignal[] = [];
  const maturity = getBaselineMaturity(history, settings);
  const normalCeiling = borrower.expectedMonthlyPayment * settings.normalPaymentRangeMultiplier;

  const mpsConfig = configs['MULTIPLE_PAYMENT_SOURCES'];
  if (mpsConfig?.enabled) {
    // Counts real funding sources (h.fundingSource, e.g. BIN-last4) inside windowDays —
    // NOT h.paymentMethod, which holds the per-transaction PNREF. Payments whose source
    // could not be resolved are ignored rather than counted as distinct.
    const windowDays = mpsConfig.parameters['windowDays'] ?? 7;
    const threshold = mpsConfig.parameters['minimumSources'] ?? 3;
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const withSource = history.filter((h) => !h.isRefund && h.fundingSource);
    const windowSources = new Set(withSource.filter((h) => h.createdAt >= cutoff).map((h) => h.fundingSource!));
    if (windowSources.size >= threshold) {
      // Sources already seen before the window by a borrower with ESTABLISHED/MATURE
      // history are the borrower's known instruments, not funding-source rotation.
      const priorSources = new Set(withSource.filter((h) => h.createdAt < cutoff).map((h) => h.fundingSource!));
      const allKnown = [...windowSources].every((s) => priorSources.has(s));
      if (settings.suppressionsEnabled && (maturity === 'ESTABLISHED' || maturity === 'MATURE') && allKnown) {
        suppressed.push({
          scenario: 'MULTIPLE_PAYMENT_SOURCES',
          reason: `${windowSources.size} payment sources in ${windowDays}d, but all were already used earlier and borrower has ${maturity} history — known instruments, not flagged.`,
          value: windowSources.size,
        });
      } else {
        signals.push({
          scenario: 'MULTIPLE_PAYMENT_SOURCES',
          description: `${windowSources.size} distinct payment sources used within ${windowDays} days on loan ${borrower.loanId}.`,
          value: windowSources.size,
          threshold,
        });
      }
    }
  }

  // PAYMENT_VELOCITY / SAME_DAY_VELOCITY: a borrower making several same-sized EMI
  // payments (catching up, biweekly, paying extra) is normal — see PROJECT.md
  // "Most Critical Design Principle". Only flag velocity when at least one of the
  // payments involved is itself abnormally large (not just frequent).
  const pvConfig = configs['PAYMENT_VELOCITY'];
  if (pvConfig?.enabled) {
    const windowDays = pvConfig.parameters['windowDays'] ?? 7;
    const maxPayments = pvConfig.parameters['maxPayments'] ?? 5;
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const recent = history.filter((h) => h.createdAt >= cutoff && !h.isRefund);
    if (recent.length > maxPayments) {
      const allNormalSized = normalCeiling <= 0 || recent.every((h) => h.amount <= normalCeiling);
      if (settings.suppressionsEnabled && allNormalSized) {
        suppressed.push({
          scenario: 'PAYMENT_VELOCITY',
          reason: `${recent.length} payments in ${windowDays}d but all within normal EMI size (≤${normalCeiling.toFixed(2)}) — treated as extra/catch-up payments, not flagged.`,
          value: recent.length,
        });
      } else {
        signals.push({
          scenario: 'PAYMENT_VELOCITY',
          description: `${recent.length} payments made within ${windowDays} days on loan ${borrower.loanId}.`,
          value: recent.length,
          threshold: maxPayments,
        });
      }
    }
  }

  const adConfig = configs['AMOUNT_DEVIATION'];
  if (adConfig?.enabled && borrower.expectedMonthlyPayment > 0) {
    const amount = parseFloat(tx.amount.value);
    const multiplier = adConfig.parameters['deviationMultiplier'] ?? 2;
    const threshold = borrower.expectedMonthlyPayment * multiplier;
    if (amount > threshold) {
      // A single large payment from a borrower with MATURE history is presumed to be
      // a legitimate principal payoff / catch-up, not deviation — per PROJECT.md
      // suppression table ("Single large payment with ESTABLISHED history").
      if (settings.suppressionsEnabled && maturity === 'MATURE') {
        suppressed.push({
          scenario: 'AMOUNT_DEVIATION',
          reason: `Payment of $${amount.toFixed(2)} exceeds ${multiplier}× expected, but borrower has MATURE payment history (payments on ${countPaymentDays(history)} distinct days) — likely legitimate principal/catch-up payment.`,
          value: amount.toFixed(2),
        });
      } else {
        signals.push({
          scenario: 'AMOUNT_DEVIATION',
          description: `Payment of $${amount.toFixed(2)} exceeds ${multiplier}× the expected monthly payment of $${borrower.expectedMonthlyPayment.toFixed(2)}.`,
          value: amount.toFixed(2),
          threshold: threshold.toFixed(2),
        });
      }
    }
  }

  const rdcConfig = configs['REFUND_DISPUTE_CYCLE'];
  if (rdcConfig?.enabled) {
    const hasRefunds = history.some((h) => h.isRefund);
    const hasDisputes = history.some((h) => h.isDispute);
    if (hasRefunds && hasDisputes) {
      const refundCount = history.filter((h) => h.isRefund).length;
      const disputeCount = history.filter((h) => h.isDispute).length;
      signals.push({
        scenario: 'REFUND_DISPUTE_CYCLE',
        description: `Loan ${borrower.loanId} shows a refund-dispute pattern: ${refundCount} refund(s) and ${disputeCount} dispute(s).`,
        value: `${refundCount} refunds, ${disputeCount} disputes`,
        threshold: 'any combination',
      });
    }
  }

  const sdvConfig = configs['SAME_DAY_VELOCITY'];
  if (sdvConfig?.enabled) {
    const maxPayments = sdvConfig.parameters['maxPayments'] ?? 2;
    const todayStart = new Date(new Date(tx.createdAt).toDateString()).toISOString();
    const todayPayments = history.filter((h) => !h.isRefund && h.createdAt >= todayStart);
    if (todayPayments.length > maxPayments) {
      const txAmount = parseFloat(tx.amount.value);
      const allNormalSized =
        normalCeiling <= 0 || (txAmount <= normalCeiling && todayPayments.every((h) => h.amount <= normalCeiling));
      if (settings.suppressionsEnabled && allNormalSized) {
        suppressed.push({
          scenario: 'SAME_DAY_VELOCITY',
          reason: `${todayPayments.length + 1} same-day payments but all within normal EMI size (≤${normalCeiling.toFixed(2)}) — e.g. borrower paying 2-3× EMI same day, not flagged.`,
          value: todayPayments.length + 1,
        });
      } else {
        signals.push({
          scenario: 'SAME_DAY_VELOCITY',
          description: `${todayPayments.length + 1} payments on loan ${borrower.loanId} within the same calendar day.`,
          value: todayPayments.length + 1,
          threshold: maxPayments,
        });
      }
    }
  }

  const riskScore = Math.min(100, signals.length * 25);
  // Per PROJECT.md Section 12 target architecture: a single signal must NOT create an
  // alert. Only correlated signals (score ≥ amlAlertThreshold) do.
  const triggered = riskScore >= settings.amlAlertThreshold;
  const monitor = !triggered && riskScore >= MONITOR_MIN_SCORE;
  return { triggered, monitor, riskScore, signals, suppressed };
}
