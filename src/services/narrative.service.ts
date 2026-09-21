import type { BorrowerContext, PaymentHistory } from './appsolute.service.js';
import type { BraintreeTransaction } from './braintree.service.js';
import type { SystemSettings } from './settings.service.js';
import { getBaselineMaturity, type BaselineMaturity } from './aml-engine.service.js';

/** Plain-data snapshot of the baseline at evaluation time — small enough to pass through the alert store. */
export interface NarrativeContext {
  loanId: string;
  expectedMonthlyPayment: number;
  maturity: BaselineMaturity;
  paymentCount: number;
  /** Amount of the triggering payment, if known. */
  amount?: number;
}

/** Fraud signals carry `rule`; AML signals carry `scenario`. */
export type NarrativeSignal = { rule?: string; scenario?: string; description?: string; value?: unknown; threshold?: unknown };

/** getPaymentHistory() default lookback — keep in sync with appsolute.service.ts. */
const HISTORY_WINDOW_DAYS = 30;

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const MATURITY_TEXT: Record<BaselineMaturity, string> = {
  NEW: 'no prior payment history',
  INSUFFICIENT_HISTORY: 'a limited payment history',
  ESTABLISHED: 'an established payment history',
  MATURE: 'a mature payment history',
};

// Short plain-language label per scenario (the "Flagged:" list) — never the raw enum name.
const LABELS: Record<string, string> = {
  MULTIPLE_PAYMENT_SOURCES: 'multiple payment sources',
  PAYMENT_VELOCITY: 'high payment frequency',
  AMOUNT_DEVIATION: 'unusual payment amount',
  REFUND_DISPUTE_CYCLE: 'refund and dispute pattern',
  SAME_DAY_VELOCITY: 'repeated same-day payments',
  GATEWAY_REJECTION: 'gateway rejection',
  DUPLICATE_PAYMENT: 'possible duplicate payment',
  BIN_COUNTRY_MISMATCH: 'card issued in a different country',
};

const key = (s: NarrativeSignal) => s.rule ?? s.scenario ?? '';

/** One clause describing why a signal fired, phrased to follow "…because ". */
function phrase(s: NarrativeSignal, ctx: NarrativeContext): string {
  const v = s.value;
  switch (key(s)) {
    case 'MULTIPLE_PAYMENT_SOURCES':
      return `${v} different cards or funding sources were used within a short period`;
    case 'PAYMENT_VELOCITY':
      return `${v} payments were made in a short period, well above the normal ${s.threshold}`;
    case 'AMOUNT_DEVIATION': {
      const amount = Number(v);
      const ratio = ctx.expectedMonthlyPayment > 0 ? ` (${(amount / ctx.expectedMonthlyPayment).toFixed(1)}× the expected amount)` : '';
      return `a payment of ${usd(amount)} is far above the expected monthly amount${ratio}`;
    }
    case 'REFUND_DISPUTE_CYCLE':
      return `the loan shows both refunds and customer disputes (${v})`;
    case 'SAME_DAY_VELOCITY':
      return `${v} payments landed on the loan on the same day`;
    case 'GATEWAY_REJECTION':
      return 'the payment gateway rejected the transaction';
    case 'DUPLICATE_PAYMENT':
      return `the same amount was submitted ${v} times within a short time`;
    case 'BIN_COUNTRY_MISMATCH': {
      const [card, borrower] = String(v).split(' vs ');
      return `the card was issued in ${card} while the borrower is based in ${borrower}`;
    }
    default:
      return (s.description ?? 'an unusual pattern was detected').replace(/\.$/, '');
  }
}

function joinAnd(parts: string[]): string {
  if (parts.length <= 1) return parts.join('');
  return `${parts.slice(0, -1).join('; ')}; and ${parts[parts.length - 1]}`;
}

/** Builds the baseline snapshot used by the narrative. */
export function buildNarrativeContext(
  borrower: BorrowerContext,
  history: PaymentHistory[],
  settings: SystemSettings,
  tx?: BraintreeTransaction
): NarrativeContext {
  const amount = tx ? parseFloat(tx.amount.value) : NaN;
  return {
    loanId: borrower.loanId,
    expectedMonthlyPayment: borrower.expectedMonthlyPayment,
    maturity: getBaselineMaturity(history, settings),
    paymentCount: history.filter((h) => !h.isRefund).length,
    ...(Number.isFinite(amount) && { amount }),
  };
}

/** Renders the one-paragraph, plain-English explanation of an alert. Pure — safe to call on merge. */
export function renderNarrative(type: string, signals: NarrativeSignal[], ctx: NarrativeContext): string {
  const expected = ctx.expectedMonthlyPayment > 0
    ? `Expected payment is ${usd(ctx.expectedMonthlyPayment)}/month`
    : 'Expected monthly payment is not known';
  // AML judges a pattern against the borrower's own baseline, so say so when there isn't one to trust.
  const lowConfidence = type !== 'FRAUD' && (ctx.maturity === 'NEW' || ctx.maturity === 'INSUFFICIENT_HISTORY')
    ? ', so there is not enough history to establish a reliable baseline'
    : '';
  const baseline = `the borrower has ${MATURITY_TEXT[ctx.maturity]} (${plural(ctx.paymentCount, 'payment')} in the last ${HISTORY_WINDOW_DAYS} days)${lowConfidence}`;
  const trigger = ctx.amount !== undefined ? ` The triggering payment was ${usd(ctx.amount)}.` : '';

  const why = joinAnd(signals.map((s) => phrase(s, ctx)));
  const lead = type === 'FRAUD'
    ? 'This transaction was flagged because'
    : signals.length > 1 ? 'This borrower’s activity was flagged because several patterns occurred together:' : 'This borrower’s activity was flagged because';
  const flagged = [...new Set(signals.map((s) => LABELS[key(s)] ?? 'other risk signal'))].join(', ');

  return `Loan ${ctx.loanId}: ${expected}, and ${baseline}.${trigger} ${lead} ${why}. Flagged: ${flagged}.`;
}

/** Convenience wrapper: baseline snapshot + render, from the same inputs the engines receive. */
export function generateAlertNarrative(
  alert: { type: string; signals: NarrativeSignal[] },
  borrower: BorrowerContext,
  history: PaymentHistory[],
  settings: SystemSettings,
  tx?: BraintreeTransaction
): string {
  return renderNarrative(alert.type, alert.signals, buildNarrativeContext(borrower, history, settings, tx));
}
