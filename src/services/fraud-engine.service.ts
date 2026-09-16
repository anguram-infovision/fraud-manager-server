import type { BraintreeTransaction } from './braintree.service.js';
import type { BorrowerContext, PaymentHistory } from './appsolute.service.js';
import { DEFAULT_SETTINGS, type SystemSettings } from './settings.service.js';
import { getBaselineMaturity } from './aml-engine.service.js';

export interface FraudSignal {
  rule: string;
  description: string;
  value: string | number;
}

export interface SuppressedSignal {
  rule: string;
  reason: string;
  value: string | number;
}

export interface FraudEvaluation {
  triggered: boolean;
  riskScore: number;
  signals: FraudSignal[];
  suppressed: SuppressedSignal[];
  relatedTransactionIds: string[];
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
  borrower?: BorrowerContext,
  settings: SystemSettings = DEFAULT_SETTINGS,
): FraudEvaluation {
  const signals: FraudSignal[] = [];
  const suppressed: SuppressedSignal[] = [];

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
  // AFS history stores Braintree legacyId (PNREF) as paymentMethod.
  // Exclude: (1) the current tx itself via PNREF match, (2) orderId retries (system retries, not fraud).
  const genuineDuplicates = history.filter(h =>
    !h.isRefund &&
    Math.abs(h.amount - txAmount) < 0.01 &&
    h.createdAt >= cutoff &&
    h.paymentMethod !== tx.legacyId &&
    !(tx.orderId && h.orderId === tx.orderId)
  );
  const relatedTransactionIds: string[] = [];
  if (genuineDuplicates.length >= 1) {
    genuineDuplicates.forEach(h => { if (h.transactionId) relatedTransactionIds.push(h.transactionId); });

    // A repeated payment at a NORMAL EMI amount (not an abnormally large one) from a
    // borrower with at least ESTABLISHED history is far more likely to be the borrower
    // paying their EMI multiple times (catching up, extra payment) than duplicate
    // fraud. Only flag when the amount is itself unusual or the borrower has no track
    // record to judge normalcy against.
    const normalCeiling = borrower && borrower.expectedMonthlyPayment > 0
      ? borrower.expectedMonthlyPayment * settings.normalPaymentRangeMultiplier
      : 0;
    const isNormalSized = normalCeiling > 0 && txAmount <= normalCeiling;
    const maturity = borrower ? getBaselineMaturity(history, settings) : 'NEW';
    const hasTrackRecord = maturity === 'ESTABLISHED' || maturity === 'MATURE';

    if (settings.suppressionsEnabled && isNormalSized && hasTrackRecord) {
      suppressed.push({
        rule: 'DUPLICATE_PAYMENT',
        reason: `Payment of $${txAmount.toFixed(2)} repeated ${genuineDuplicates.length + 1}× within ${windowMinutes} min, but amount is within normal EMI range and borrower has ${maturity} history — treated as extra/catch-up payments, not duplicate fraud.`,
        value: genuineDuplicates.length + 1,
      });
    } else {
      signals.push({
        rule: 'DUPLICATE_PAYMENT',
        description: `Payment of $${txAmount.toFixed(2)} appears ${genuineDuplicates.length + 1}× within ${windowMinutes} min window.`,
        value: genuineDuplicates.length + 1,
      });
    }
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
  return { triggered: signals.length > 0, riskScore, signals, suppressed, relatedTransactionIds };
}
