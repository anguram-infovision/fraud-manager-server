/**
 * Phase 0: Braintree Capability Audit
 *
 * Usage:
 *   1. Populate server/.env with sandbox BT_MERCHANT_ID, BT_PUBLIC_KEY, BT_PRIVATE_KEY
 *   2. Set a real sandbox transaction ID below (create one in the Braintree sandbox UI)
 *   3. npx tsx scripts/bt-capability-audit.ts
 *
 * Reports which fields are actually returned by the GraphQL API vs. null/undefined.
 */
import 'dotenv/config';
import axios from 'axios';

const TRANSACTION_ID = process.env['AUDIT_TRANSACTION_ID'] ?? '';

if (!TRANSACTION_ID) {
  console.error('Set AUDIT_TRANSACTION_ID env var to a sandbox transaction ID');
  process.exit(1);
}

const GQL_URL = 'https://payments.sandbox.braintree-api.com/graphql';
const auth = Buffer.from(`${process.env['BT_PUBLIC_KEY']}:${process.env['BT_PRIVATE_KEY']}`).toString('base64');

async function query(q: string, variables: Record<string, unknown> = {}) {
  const res = await axios.post(GQL_URL, { query: q, variables }, {
    headers: {
      Authorization: `Basic ${auth}`,
      'Braintree-Version': '2019-01-01',
      'Content-Type': 'application/json',
    },
  });
  if (res.data.errors?.length) {
    throw new Error('GraphQL errors:\n' + JSON.stringify(res.data.errors, null, 2));
  }
  return res.data.data;
}

const FULL_QUERY = `
  query Audit($id: ID!) {
    node(id: $id) {
      ... on Transaction {
        id
        status
        amount { value currencyCode }
        createdAt
        orderId
        paymentMethodSnapshot {
          ... on CreditCardDetails {
            last4
            bin
            expirationMonth
            expirationYear
            cardholderName
          }
          ... on PayPalTransactionDetails {
            payerStatus
          }
          ... on VenmoAccountDetails {
            username
          }
          ... on UsBankAccountDetails {
            last4
            bankName
            accountType
          }
        }
        statusHistory { status source timestamp }
        riskData { decision deviceDataCaptured fraudServiceProvider id }
      }
    }
  }
`;

function audit(obj: unknown, path = '', results: Record<string, string> = {}): Record<string, string> {
  if (obj === null) { results[path] = 'null'; return results; }
  if (obj === undefined) { results[path] = 'undefined'; return results; }
  if (Array.isArray(obj)) {
    if (obj.length === 0) { results[path] = '[] (empty)'; return results; }
    audit(obj[0], `${path}[0]`, results);
    return results;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      audit(v, path ? `${path}.${k}` : k, results);
    }
    return results;
  }
  results[path] = String(obj);
  return results;
}

async function main() {
  console.log(`\nAuditing transaction: ${TRANSACTION_ID}\n`);
  try {
    const data = await query(FULL_QUERY, { id: TRANSACTION_ID });
    const tx = data.node;
    if (!tx) { console.error('Transaction not found'); process.exit(1); }

    const fields = audit(tx);
    const present: string[] = [], absent: string[] = [];
    for (const [k, v] of Object.entries(fields)) {
      if (v === 'null' || v === 'undefined') absent.push(k);
      else present.push(`${k}: ${v}`);
    }

    console.log('=== PRESENT FIELDS ===');
    present.forEach(f => console.log(' ✓ ' + f));
    console.log('\n=== NULL / ABSENT FIELDS ===');
    absent.forEach(f => console.log(' ✗ ' + f));
    console.log('\n=== RAW RESPONSE ===');
    console.log(JSON.stringify(tx, null, 2));
  } catch (err) {
    console.error('Audit failed:', err);
    process.exit(1);
  }
}

main();
