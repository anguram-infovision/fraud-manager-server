import type { BraintreeTransaction } from './braintree.service.js';
import { capabilityTier } from './braintree.service.js';

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

  if (tx.gatewayRejectionReason) {
    signals.push({
      rule: 'GATEWAY_REJECTION',
      description: `Transaction rejected by gateway: ${tx.gatewayRejectionReason}`,
      value: tx.gatewayRejectionReason,
    });
  }

  if (capabilityTier === 'premium' && tx.riskData?.decision) {
    const decision = tx.riskData.decision;
    if (decision === 'Review' || decision === 'Decline') {
      signals.push({
        rule: 'BRAINTREE_RISK_DECISION',
        description: `Braintree ML risk decision: ${decision}`,
        value: decision,
      });
    }
  }

  const riskScore = Math.min(100, signals.length * 30);
  return { triggered: signals.length > 0, riskScore, signals };
}
