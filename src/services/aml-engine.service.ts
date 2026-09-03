import type { BorrowerContext, PaymentHistory } from './appsolute.service.js';
import type { BraintreeTransaction } from './braintree.service.js';

export interface AmlRiskSignal {
  scenario: string;
  description: string;
  value: string | number;
  threshold: string | number;
}

export interface AmlEvaluation {
  triggered: boolean;
  riskScore: number;
  signals: AmlRiskSignal[];
}

export interface ScenarioConfig {
  enabled: boolean;
  parameters: Record<string, number>;
  severity: string;
}

export type ScenarioConfigs = Record<string, ScenarioConfig>;

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
};

export function evaluateAml(
  tx: BraintreeTransaction,
  borrower: BorrowerContext,
  history: PaymentHistory[],
  configs: ScenarioConfigs = DEFAULT_CONFIGS
): AmlEvaluation {
  const signals: AmlRiskSignal[] = [];

  const mpsConfig = configs['MULTIPLE_PAYMENT_SOURCES'];
  if (mpsConfig?.enabled) {
    const uniqueSources = new Set(history.map((h) => h.paymentMethod)).size;
    const threshold = mpsConfig.parameters['minimumSources'] ?? 3;
    if (uniqueSources >= threshold) {
      signals.push({
        scenario: 'MULTIPLE_PAYMENT_SOURCES',
        description: `${uniqueSources} distinct payment methods detected on loan ${borrower.loanId}.`,
        value: uniqueSources,
        threshold,
      });
    }
  }

  const pvConfig = configs['PAYMENT_VELOCITY'];
  if (pvConfig?.enabled) {
    const windowDays = pvConfig.parameters['windowDays'] ?? 7;
    const maxPayments = pvConfig.parameters['maxPayments'] ?? 5;
    const cutoff = new Date(Date.now() - windowDays * 86_400_000).toISOString();
    const recent = history.filter((h) => h.createdAt >= cutoff && !h.isRefund);
    if (recent.length > maxPayments) {
      signals.push({
        scenario: 'PAYMENT_VELOCITY',
        description: `${recent.length} payments made within ${windowDays} days on loan ${borrower.loanId}.`,
        value: recent.length,
        threshold: maxPayments,
      });
    }
  }

  const adConfig = configs['AMOUNT_DEVIATION'];
  if (adConfig?.enabled && borrower.expectedMonthlyPayment > 0) {
    const amount = parseFloat(tx.amount.value);
    const multiplier = adConfig.parameters['deviationMultiplier'] ?? 2;
    const threshold = borrower.expectedMonthlyPayment * multiplier;
    if (amount > threshold) {
      signals.push({
        scenario: 'AMOUNT_DEVIATION',
        description: `Payment of $${amount.toFixed(2)} exceeds ${multiplier}× the expected monthly payment of $${borrower.expectedMonthlyPayment.toFixed(2)}.`,
        value: amount.toFixed(2),
        threshold: threshold.toFixed(2),
      });
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

  const riskScore = Math.min(100, signals.length * 25);
  return { triggered: signals.length > 0, riskScore, signals };
}
