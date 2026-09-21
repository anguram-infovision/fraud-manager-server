import axios from 'axios';
import 'dotenv/config';

const PUBLIC_KEY = process.env['BT_PUBLIC_KEY'] ?? process.env['BRAINTREE_PUBLIC_KEY'] ?? '';
const PRIVATE_KEY = process.env['BT_PRIVATE_KEY'] ?? process.env['BRAINTREE_PRIVATE_KEY'] ?? '';

const GQL_URL =
  process.env['BRAINTREE_GRAPHQL_URL'] ??
  (process.env['BT_ENVIRONMENT'] === 'production'
    ? 'https://payments.braintree-api.com/graphql'
    : 'https://payments.sandbox.braintree-api.com/graphql');

const authHeader = Buffer.from(`${PUBLIC_KEY}:${PRIVATE_KEY}`).toString('base64');

const GQL_TIMEOUT_MS = 20_000;

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  // BT_OFFLINE=true short-circuits every Braintree call (used by scripts/alert-comparison.ts --no-braintree).
  if (process.env['BT_OFFLINE'] === 'true') throw new Error('Braintree offline mode');
  const res = await axios.post<{ data: T; errors?: unknown[] }>(
    GQL_URL,
    { query, variables },
    {
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Braintree-Version': '2019-01-01',
        'Content-Type': 'application/json',
      },
      timeout: GQL_TIMEOUT_MS,
    }
  );
  if (res.data.errors?.length) throw new Error(JSON.stringify(res.data.errors));
  return res.data.data;
}

export interface BraintreeTransaction {
  id: string;
  legacyId?: string;
  amount: { value: string; currencyCode: string };
  status: string;
  createdAt: string;
  orderId?: string;
  merchantAccountId?: string;
  customer?: { firstName?: string; lastName?: string };
  paymentMethodSnapshot?: {
    last4?: string;
    bin?: string;
    brandCode?: string;
    /** Braintree-issued fingerprint of the card number — stable across re-entries of the same card. */
    uniqueNumberIdentifier?: string;
    expirationMonth?: string;
    expirationYear?: string;
    cardholderName?: string;
    binData?: {
      prepaid?: string;
      healthcare?: string;
      countryOfIssuance?: string;
      issuingBank?: string;
    };
  };
  statusHistory?: { status: string; source?: string; timestamp?: string }[];
  gatewayRejectionReason?: string;
  processorResponseCode?: string;
  processorResponseText?: string;
  avsPostalCodeResponseCode?: string;
  avsStreetAddressResponseCode?: string;
  cvvResponseCode?: string;
  riskData?: { decision?: string; id?: string; deviceDataCaptured?: boolean };
}

// Shape of Transaction.processorAuthorizationResponse (TransactionAuthorizationProcessorResponse) on the live schema.
interface ProcessorAuthorizationResponse {
  legacyCode?: string | null;
  message?: string | null;
  cvvResponse?: string | null;
  avsPostalCodeResponse?: string | null;
  avsStreetAddressResponse?: string | null;
}

// node(id) requires unpadded base64 global ID: base64("transaction_<legacyId>") with = stripped.
const TRANSACTION_QUERY = `
  query GetTransaction($id: ID!) {
    node(id: $id) {
      ... on Transaction {
        id
        legacyId
        amount { value currencyCode }
        status
        createdAt
        orderId
        merchantAccountId
        processorAuthorizationResponse {
          legacyCode
          message
          cvvResponse
          avsPostalCodeResponse
          avsStreetAddressResponse
        }
        riskData { decision id deviceDataCaptured }
        customer { firstName lastName }
        paymentMethodSnapshot {
          ... on CreditCardDetails {
            last4
            bin
            brandCode
            uniqueNumberIdentifier
            expirationMonth
            expirationYear
            cardholderName
            binData {
              prepaid
              healthcare
              countryOfIssuance
              issuingBank
            }
          }
        }
      }
    }
  }
`;

export async function getTransaction(id: string): Promise<BraintreeTransaction | null> {
  // If already a global ID (long, no padding issues) use as-is; otherwise encode legacy short ID.
  const globalId = id.length > 20
    ? id
    : Buffer.from(`transaction_${id}`).toString('base64').replace(/=/g, '');
  const data = await gql<{ node: (BraintreeTransaction & { processorAuthorizationResponse?: ProcessorAuthorizationResponse | null }) | null }>(
    TRANSACTION_QUERY, { id: globalId }
  );
  const raw = data.node;
  if (!raw) return null;
  const { processorAuthorizationResponse: pr, ...tx } = raw;
  return {
    ...tx,
    ...(pr?.legacyCode && { processorResponseCode: pr.legacyCode }),
    ...(pr?.message && { processorResponseText: pr.message }),
    ...(pr?.cvvResponse && { cvvResponseCode: pr.cvvResponse }),
    ...(pr?.avsPostalCodeResponse && { avsPostalCodeResponseCode: pr.avsPostalCodeResponse }),
    ...(pr?.avsStreetAddressResponse && { avsStreetAddressResponseCode: pr.avsStreetAddressResponse }),
  };
}

/** Flattens a Braintree transaction into the compact shape stored as `alerts.braintreeSignals`. */
export function toBraintreeSignals(tx: BraintreeTransaction): Record<string, unknown> {
  return {
    status: tx.status,
    ...(tx.merchantAccountId && { merchantAccountId: tx.merchantAccountId }),
    ...(tx.gatewayRejectionReason && { gatewayRejectionReason: tx.gatewayRejectionReason }),
    ...(tx.processorResponseCode && { processorResponseCode: tx.processorResponseCode }),
    ...(tx.processorResponseText && { processorResponseText: tx.processorResponseText }),
    ...(tx.avsPostalCodeResponseCode && { avsPostalCodeResponseCode: tx.avsPostalCodeResponseCode }),
    ...(tx.avsStreetAddressResponseCode && { avsStreetAddressResponseCode: tx.avsStreetAddressResponseCode }),
    ...(tx.cvvResponseCode && { cvvResponseCode: tx.cvvResponseCode }),
    ...(tx.riskData?.decision && { riskDecision: tx.riskData.decision }),
    ...(tx.riskData?.deviceDataCaptured !== undefined && { deviceDataCaptured: tx.riskData.deviceDataCaptured }),
    ...(tx.paymentMethodSnapshot?.bin && { bin: tx.paymentMethodSnapshot.bin }),
    ...(tx.paymentMethodSnapshot?.last4 && { last4: tx.paymentMethodSnapshot.last4 }),
    ...(tx.paymentMethodSnapshot?.cardholderName && { cardholderName: tx.paymentMethodSnapshot.cardholderName }),
    ...(tx.paymentMethodSnapshot?.binData?.countryOfIssuance && { cardCountry: tx.paymentMethodSnapshot.binData.countryOfIssuance }),
    ...(tx.paymentMethodSnapshot?.binData?.issuingBank && { issuingBank: tx.paymentMethodSnapshot.binData.issuingBank }),
  };
}

/**
 * Stable funding-source key for a card transaction. Prefers Braintree's uniqueNumberIdentifier
 * (a fingerprint of the card number, so the same card re-entered is still one source); falls back
 * to BIN + last4 when the fingerprint isn't returned.
 */
export function fundingSourceKey(tx: BraintreeTransaction): string | null {
  const { uniqueNumberIdentifier, brandCode, bin, last4 } = tx.paymentMethodSnapshot ?? {};
  if (uniqueNumberIdentifier) return `${brandCode ?? 'card'}-${uniqueNumberIdentifier}`;
  return bin && last4 ? `${bin}-${last4}` : null;
}

// A settled transaction's card never changes, so resolved keys are cached for the process lifetime.
const fundingSourceCache = new Map<string, string>();
const FUNDING_LOOKUP_CONCURRENCY = 5;

/**
 * Resolves PNREF (legacyId) → funding-source key. PNREFs whose lookup fails or has no
 * card details are omitted from the result (callers treat them as "unknown source").
 */
export async function getFundingSources(pnrefs: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const missing: string[] = [];
  for (const id of new Set(pnrefs)) {
    const hit = fundingSourceCache.get(id);
    if (hit) result.set(id, hit);
    else missing.push(id);
  }
  for (let i = 0; i < missing.length; i += FUNDING_LOOKUP_CONCURRENCY) {
    await Promise.all(
      missing.slice(i, i + FUNDING_LOOKUP_CONCURRENCY).map(async (id) => {
        try {
          const tx = await getTransaction(id);
          const key = tx ? fundingSourceKey(tx) : null;
          if (key) { fundingSourceCache.set(id, key); result.set(id, key); }
        } catch { /* non-fatal — source stays unknown */ }
      })
    );
  }
  return result;
}

export const capabilityTier = (process.env['BT_CAPABILITY_TIER'] ?? 'basic') as
  | 'basic'
  | 'premium';

// Returns the set of transaction legacyIds (Braintree short IDs) that have active disputes.
// Used to set isDispute=true in payment history for REFUND_DISPUTE_CYCLE detection.
const DISPUTES_QUERY = `
  query GetDisputes($ids: [String!]!) {
    disputes(input: { transaction: { id: { in: $ids } } }) {
      edges {
        node {
          status
          transaction { legacyId }
        }
      }
    }
  }
`;

export async function getDisputedTransactionIds(legacyIds: string[]): Promise<Set<string>> {
  if (!legacyIds.length) return new Set();
  try {
    const data = await gql<{ disputes: { edges: { node: { status: string; transaction: { legacyId: string } } }[] } }>(
      DISPUTES_QUERY, { ids: legacyIds }
    );
    return new Set(
      data.disputes.edges
        .filter(e => e.node.status !== 'WON') // WON = merchant won, not a real dispute burden
        .map(e => e.node.transaction.legacyId)
    );
  } catch {
    return new Set(); // non-fatal — AML degrades gracefully
  }
}
