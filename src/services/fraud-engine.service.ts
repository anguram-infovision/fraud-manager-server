import type { BraintreeTransaction } from './braintree.service.js';

export interface FraudSignal {
  rule: string;
  description: string;
  value: string | number;
}

export interface FraudEvaluation {
  triggered: boolean;
  riskScore: number;
  signals: FraudSignal[];
}

export function evaluateFraud(tx: BraintreeTransaction): FraudEvaluation {
  const signals: FraudSignal[] = [];

  // Phase 0 finding: gatewayRejectionReason and riskData not available in basic tier API version.
  // Status GATEWAY_REJECTED indicates a gateway rejection even without the reason field.
  if (tx.status === 'GATEWAY_REJECTED') {
    signals.push({
      rule: 'GATEWAY_REJECTION',
      description: `Transaction status is GATEWAY_REJECTED (orderId: ${tx.orderId ?? 'n/a'})`,
      value: tx.status,
    });
  }

  const riskScore = Math.min(100, signals.length * 30);
  return { triggered: signals.length > 0, riskScore, signals };
}
