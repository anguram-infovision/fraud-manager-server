import type { BraintreeTransaction } from './braintree.service.js';
import type { PaymentHistory } from './appsolute.service.js';

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

// BIN prefix → ISO 3166-1 alpha-2 country. Covers the most common sandbox/test BINs.
// Extend with a full BIN-to-country lookup service for production.
const BIN_COUNTRY: Record<string, string> = {
  '401288': 'US', '411111': 'US', '378282': 'US', // common test cards (US)
  '400000': 'US', '510510': 'US', '601111': 'US',
};

function binToCountry(bin: string | undefined): string | null {
  if (!bin) return null;
  return BIN_COUNTRY[bin] ?? null;
}

export function evaluateFraud(
  tx: BraintreeTransaction,
  history: PaymentHistory[] = [],
  borrowerCountry = 'US',
  windowMinutes = 60,
): FraudEvaluation {
  const signals: FraudSignal[] = [];

  // Phase 0: gateway rejection (only fraud signal available in basic tier)
  if (tx.status === 'GATEWAY_REJECTED') {
    signals.push({
      rule: 'GATEWAY_REJECTION',
      description: `Transaction status is GATEWAY_REJECTED (orderId: ${tx.orderId ?? 'n/a'})`,
      value: tx.status,
    });
  }

  // Duplicate payment: same amount submitted >1 times within windowMinutes for this loan
  const txAmount = parseFloat(tx.amount.value);
  const cutoff = new Date(new Date(tx.createdAt).getTime() - windowMinutes * 60_000).toISOString();
  const duplicates = history.filter(
    h => !h.isRefund && Math.abs(h.amount - txAmount) < 0.01 && h.createdAt >= cutoff
  );
  if (duplicates.length >= 1) {
    signals.push({
      rule: 'DUPLICATE_PAYMENT',
      description: `Payment of $${txAmount.toFixed(2)} appears ${duplicates.length + 1}× within ${windowMinutes} min window.`,
      value: duplicates.length + 1,
    });
  }

  // BIN country mismatch: card issued in a different country from borrower's address
  const cardCountry = binToCountry(tx.paymentMethodSnapshot?.bin);
  if (cardCountry && cardCountry !== borrowerCountry) {
    signals.push({
      rule: 'BIN_COUNTRY_MISMATCH',
      description: `Card BIN ${tx.paymentMethodSnapshot?.bin} is from ${cardCountry}, borrower country is ${borrowerCountry}.`,
      value: `${cardCountry} vs ${borrowerCountry}`,
    });
  }

  const riskScore = Math.min(100, signals.length * 30);
  return { triggered: signals.length > 0, riskScore, signals };
}
