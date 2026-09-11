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

async function gql<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const res = await axios.post<{ data: T; errors?: unknown[] }>(
    GQL_URL,
    { query, variables },
    {
      headers: {
        Authorization: `Basic ${authHeader}`,
        'Braintree-Version': '2019-01-01',
        'Content-Type': 'application/json',
      },
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
    expirationMonth?: string;
    expirationYear?: string;
    cardholderName?: string;
  };
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
        customer { firstName lastName }
        paymentMethodSnapshot {
          ... on CreditCardDetails {
            last4
            bin
            expirationMonth
            expirationYear
            cardholderName
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
  const data = await gql<{ node: BraintreeTransaction | null }>(TRANSACTION_QUERY, { id: globalId });
  return data.node;
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
