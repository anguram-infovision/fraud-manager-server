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

// `transaction(id)` root query added in API version 2020-09-29.
// `node(id)` inline-fragment works across all versions.
// Field set confirmed against disputes-manager working queries (API version 2018-03-06/2019-01-01).
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
  const data = await gql<{ node: BraintreeTransaction | null }>(TRANSACTION_QUERY, { id });
  return data.node;
}

export const capabilityTier = (process.env['BT_CAPABILITY_TIER'] ?? 'basic') as
  | 'basic'
  | 'premium';
