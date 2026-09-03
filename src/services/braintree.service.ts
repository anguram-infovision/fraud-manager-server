import axios from 'axios';
import 'dotenv/config';

const BT_ENV = process.env['BT_ENVIRONMENT'] ?? 'sandbox';
const PUBLIC_KEY = process.env['BT_PUBLIC_KEY'] ?? '';
const PRIVATE_KEY = process.env['BT_PRIVATE_KEY'] ?? '';

const GQL_URL =
  BT_ENV === 'production'
    ? 'https://payments.braintree-api.com/graphql'
    : 'https://payments.sandbox.braintree-api.com/graphql';

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
  amount: { value: string; currencyCode: string };
  status: string;
  createdAt: string;
  gatewayRejectionReason?: string;
  orderId?: string;
  customerId?: string;
  paymentMethodSnapshot?: {
    last4?: string;
    bin?: string;
    expirationMonth?: string;
    expirationYear?: string;
    cardholderName?: string;
    countryOfIssuance?: string;
    issuingBank?: string;
    payerEmail?: string;
  };
  /** AVS/CVV live in statusHistory processorResponse (not top-level in GraphQL API) */
  statusHistory?: Array<{
    status: string;
    source: string;
    timestamp: string;
    processorResponse?: {
      avsPostalCodeResponseCode?: string;
      avsStreetAddressResponseCode?: string;
      cvvResponseCode?: string;
      legacyCode?: string;
      message?: string;
    };
  }>;
  riskData?: {
    decision?: string;
    deviceDataCaptured?: boolean;
    fraudServiceProvider?: string;
    id?: string;
  };
}

const TRANSACTION_QUERY = `
  query GetTransaction($id: ID!) {
    transaction(id: $id) {
      id
      amount { value currencyCode }
      status
      createdAt
      gatewayRejectionReason
      orderId
      customerId
      paymentMethodSnapshot {
        ... on CreditCardDetails {
          last4
          bin
          expirationMonth
          expirationYear
          cardholderName
          countryOfIssuance
          issuingBank
        }
        ... on PayPalTransactionDetails { payerEmail }
      }
      statusHistory {
        status
        source
        timestamp
        processorResponse {
          avsPostalCodeResponseCode
          avsStreetAddressResponseCode
          cvvResponseCode
          legacyCode
          message
        }
      }
      riskData { decision deviceDataCaptured fraudServiceProvider id }
    }
  }
`;

export async function getTransaction(id: string): Promise<BraintreeTransaction | null> {
  const data = await gql<{ transaction: BraintreeTransaction | null }>(TRANSACTION_QUERY, { id });
  return data.transaction;
}

export const capabilityTier = (process.env['BT_CAPABILITY_TIER'] ?? 'basic') as
  | 'basic'
  | 'premium';
